import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/storage";
import { backupConfig, pruneBackups } from "../src/storage/backup";
import { toPgPlaceholders } from "../src/storage/postgres";
import { SqliteDatabase } from "../src/storage/sqlite";
import { memDb, tmpDir } from "./helpers";

describe("migrations", () => {
  it("are idempotent", async () => {
    const db = new SqliteDatabase(":memory:");
    expect(await migrate(db)).toEqual([1]);
    expect(await migrate(db)).toEqual([]);
  });
});

describe("sqlite database", () => {
  it("rolls back a failed transaction completely", async () => {
    const { db, repos } = await memDb();
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO settings (key, value, updated_at) VALUES ('a','1',0)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repos.settings.get("a")).toBeUndefined();
  });

  it("serialises a transaction against concurrent writers", async () => {
    const { db, repos } = await memDb();
    const tx = db.transaction(async (t) => {
      await t.run("INSERT INTO settings (key, value, updated_at) VALUES ('t','1',0)");
      await new Promise((r) => setTimeout(r, 20));
      await t.run("UPDATE settings SET value='2' WHERE key='t'");
    });
    const other = repos.settings.set("o", "x");
    await Promise.all([tx, other]);
    expect(await repos.settings.get("t")).toBe("2");
    expect(await repos.settings.get("o")).toBe("x");
  });

  it("persists to a file with owner-only permissions", async () => {
    const file = path.join(tmpDir(), "x.sqlite");
    const db = new SqliteDatabase(file);
    await migrate(db);
    await db.close();
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});

describe("postgres adapter", () => {
  it("converts ? placeholders to $n", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b IN (?, ?)")).toBe("SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)");
  });
});

describe("repositories", () => {
  it("settings: upsert and JSON helpers", async () => {
    const { repos } = await memDb();
    await repos.settings.set("k", "v1");
    await repos.settings.set("k", "v2");
    expect(await repos.settings.get("k")).toBe("v2");
    await repos.settings.setJson("j", [1, 2]);
    expect(await repos.settings.getJson("j", [])).toEqual([1, 2]);
    expect(await repos.settings.getJson("missing", "dflt")).toBe("dflt");
    expect(await repos.settings.delete("k")).toBe(true);
  });

  it("users: grants round-trip, suspend, remove", async () => {
    const { repos } = await memDb();
    await repos.users.upsert({ userId: 5, scopes: ["self", "search"], note: "friend", addedBy: 1000 });
    expect((await repos.users.get(5))?.scopes).toEqual(["self", "search"]);
    await repos.users.setEnabled(5, false);
    expect((await repos.users.get(5))?.enabled).toBe(false);
    expect(await repos.users.remove(5)).toBe(true);
    expect(await repos.users.get(5)).toBeUndefined();
  });

  it("tasks: due selection, atomic claim, cancel", async () => {
    const { repos } = await memDb();
    const a = await repos.tasks.create({ ownerId: 1, kind: "reminder", name: "a", payload: { x: 1 }, runAt: 100 });
    await repos.tasks.create({ ownerId: 1, kind: "reminder", name: "future", payload: {}, runAt: 10_000 });
    expect((await repos.tasks.due(500)).map((t) => t.id)).toEqual([a]);
    expect(await repos.tasks.claim(a)).toBe(true);
    expect(await repos.tasks.claim(a)).toBe(false); // second worker loses
    expect(await repos.tasks.recoverStuck()).toBe(1);
    expect(await repos.tasks.cancel(a, 999)).toBe(false); // wrong owner
    expect(await repos.tasks.cancel(a, 1)).toBe(true);
  });

  it("audit: records dry-runs", async () => {
    const { repos } = await memDb();
    await repos.audit.add({ actorId: 1, action: "msg.delete", target: "chat", details: { n: 3 }, dryRun: true, result: "previewed" });
    const [e] = await repos.audit.recent(5);
    expect(e).toMatchObject({ action: "msg.delete", dryRun: true, details: { n: 3 } });
  });

  it("media: unique sha256", async () => {
    const { repos } = await memDb();
    await repos.media.insert({ sha256: "abc", path: "/x", size: 3, kind: "photo" });
    await expect(repos.media.insert({ sha256: "abc", path: "/y", size: 3, kind: "photo" })).rejects.toThrow();
    expect((await repos.media.findBySha("abc"))?.path).toBe("/x");
    expect(await repos.media.stats()).toEqual({ files: 1, bytes: 3 });
  });

  it("archive: search escapes LIKE wildcards and is case-insensitive", async () => {
    const { repos } = await memDb();
    await repos.archive.upsert({ chatId: 1, messageId: 1, sentAt: 1, text: "100% Done", hasMedia: false });
    await repos.archive.upsert({ chatId: 1, messageId: 2, sentAt: 2, text: "nothing", hasMedia: false });
    expect((await repos.archive.search("100%")).map((m) => m.messageId)).toEqual([1]);
    expect((await repos.archive.search("done")).map((m) => m.messageId)).toEqual([1]);
    expect(await repos.archive.search("%")).toHaveLength(1); // literal percent, not a wildcard
    expect(await repos.archive.deleteChat(1)).toBe(2);
  });

  it("plugin state: upsert merges", async () => {
    const { repos } = await memDb();
    await repos.plugins.upsert("p", { enabled: false });
    await repos.plugins.upsert("p", { config: { a: 1 } });
    expect(await repos.plugins.get("p")).toMatchObject({ enabled: false, config: { a: 1 } });
  });
});

describe("backup", () => {
  it("writes a config snapshot (no message content / audit) and prunes old files", async () => {
    const { db, repos } = await memDb();
    await repos.settings.set("k", "v");
    await repos.archive.upsert({ chatId: 1, messageId: 1, sentAt: 1, text: "PRIVATE MESSAGE", hasMedia: false });
    const dir = path.join(tmpDir(), "backups");
    const r = await backupConfig(db, dir, 2);
    const snap = fs.readFileSync(r.snapshotFile, "utf8");
    expect(snap).toContain('"k"');
    expect(snap).not.toContain("PRIVATE MESSAGE");
    expect(fs.statSync(r.snapshotFile).mode & 0o077).toBe(0);
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, `config-2000-0${i}.json`), "{}");
    expect(pruneBackups(dir, 2).length).toBeGreaterThan(0);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("config-"))).toHaveLength(2);
  });
});
