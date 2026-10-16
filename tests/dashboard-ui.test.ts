import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const PUBLIC = path.join(__dirname, "..", "src", "dashboard", "public");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fixture(url: string): unknown {
  if (url.startsWith("/api/session")) return { csrf: "tok" };
  if (url.startsWith("/api/health")) return { status: "degraded", checkedAt: 1, checks: [{ name: "telegram", status: "ok", detail: "connected" }, { name: "disk", status: "warn", detail: "<b>low</b>" }] };
  if (url.startsWith("/api/status")) return { account: { name: "<i>Evil</i>", username: null }, masterAdminId: 1, connected: true, controlBot: false, uptimeSec: 90, queue: { running: 0, pending: 0, rejected: 0 }, metrics: {}, library: { name: "teleproto", version: "1" }, featureSummary: { supported: 1, partial: 0, unavailable: 0 }, now: 1 };
  if (url.startsWith("/api/logs")) return { entries: [{ level: "info", time: 1, msg: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>', module: "<b>m</b>", note: "<svg onload=1>" }] };
  return {};
}

async function boot() {
  const dom = new JSDOM(fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "http://127.0.0.1/" });
  const w = dom.window as unknown as Record<string, unknown> & Window & typeof globalThis;
  w.fetch = (async (url: string) => ({ ok: true, status: 200, json: async () => fixture(url) })) as never;
  w.alert = (() => undefined) as never;
  w.eval(fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8"));
  await wait(50);
  return w;
}

describe("dashboard UI", () => {
  it("renders the lamp rail and overview from API data", async () => {
    const w = await boot();
    const lamps = [...w.document.querySelectorAll(".lamp")];
    expect(lamps.map((l) => l.getAttribute("data-state"))).toEqual(["ok", "warn"]);
    expect(w.document.querySelectorAll(".tab").length).toBe(6);
    expect(w.document.getElementById("panel")?.textContent).toContain("Health checks");
  });

  it("treats account names, health details and log lines as text, never as HTML", async () => {
    const w = await boot();
    expect(w.document.querySelector("#who i")).toBeNull();
    expect(w.document.querySelector(".lamp-detail b")).toBeNull();
    const logsTab = [...w.document.querySelectorAll<HTMLButtonElement>(".tab")].find((t) => t.textContent === "Logs");
    logsTab?.click();
    await wait(50);
    const log = w.document.querySelector(".log");
    expect(log?.textContent).toContain("<img src=x");
    expect(log?.textContent).toContain("<script>");
    expect(w.document.querySelector(".log img, .log script, .log svg, .log b")).toBeNull();
    expect(w.__pwned).toBeUndefined();
  });
});
