import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { loadConfig, type AppConfig } from "../src/config";
import { createRepos, migrate } from "../src/storage";
import { SqliteDatabase } from "../src/storage/sqlite";

export const BASE_ENV: Record<string, string> = {
  TG_API_ID: "12345",
  TG_API_HASH: "0123456789abcdef0123456789abcdef",
  MASTER_ADMIN_ID: "1000",
  DASHBOARD_PASSWORD: "correct horse battery staple",
  BOT_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
};

export const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ub-test-"));

export function testConfig(over: Record<string, string> = {}, dir: string = tmpDir()): AppConfig {
  return loadConfig({ ...BASE_ENV, DATA_DIR: dir, ...over }, dir);
}

export async function memDb() {
  const db = new SqliteDatabase(":memory:");
  await migrate(db);
  return { db, repos: createRepos(db) };
}

export const silent = pino({ level: "silent" });
