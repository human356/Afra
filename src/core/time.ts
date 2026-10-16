const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "90s", "10m", "2h30m", "1d12h" → milliseconds. Returns undefined if not a pure duration. */
export function parseDuration(input: string): number | undefined {
  const s = input.trim().toLowerCase().replace(/^in\s+/, "");
  if (!/^(\d+(?:\.\d+)?[smhdw])+$/.test(s)) return undefined;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)([smhdw])/g)) total += Number(m[1]) * (UNITS[m[2] as string] as number);
  return total > 0 ? Math.round(total) : undefined;
}

/**
 * Parses "when" expressions:
 *   10m / 2h30m / in 1d          relative durations
 *   18:30                        next occurrence of that local time
 *   tomorrow 09:00               local time tomorrow
 *   2026-12-31 23:59 | ISO-8601  absolute (local time unless an offset is given)
 */
export function parseWhen(input: string, now: Date = new Date()): Date | undefined {
  const s = input.trim();
  const dur = parseDuration(s);
  if (dur !== undefined) return new Date(now.getTime() + dur);

  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return validTime(hm[1], hm[2]) ? d : undefined;
  }
  const tm = /^tomorrow\s+(\d{1,2}):(\d{2})$/i.exec(s);
  if (tm) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(Number(tm[1]), Number(tm[2]), 0, 0);
    return validTime(tm[1], tm[2]) ? d : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function validTime(h?: string, m?: string): boolean {
  return Number(h) < 24 && Number(m) < 60;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const parts: string[] = [];
  let s = Math.floor(ms / 1000);
  for (const [label, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    if (s >= size) {
      parts.push(`${Math.floor(s / size)}${label}`);
      s %= size;
    }
  }
  return parts.slice(0, 3).join(" ");
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
