import type { CommandDef } from "./types";

interface Entry {
  def: CommandDef;
  owner: string;
}

/** Holds command definitions. Plugins register under their own owner tag so they can be removed cleanly. */
export class CommandRegistry {
  private readonly byName = new Map<string, Entry>();

  register(def: CommandDef, owner = "core"): void {
    const names = [def.name, ...(def.aliases ?? [])].map((n) => n.toLowerCase());
    for (const n of names) {
      const existing = this.byName.get(n);
      if (existing && existing.owner !== owner) throw new Error(`Command "${n}" is already registered by "${existing.owner}"`);
    }
    for (const n of names) this.byName.set(n, { def, owner });
  }

  unregisterOwner(owner: string): number {
    let removed = 0;
    for (const [name, entry] of this.byName) {
      if (entry.owner === owner) {
        this.byName.delete(name);
        removed++;
      }
    }
    return removed;
  }

  get(name: string): CommandDef | undefined {
    return this.byName.get(name.toLowerCase())?.def;
  }

  /** Unique definitions (aliases collapsed). */
  list(): Array<CommandDef & { owner: string }> {
    const seen = new Set<CommandDef>();
    const out: Array<CommandDef & { owner: string }> = [];
    for (const { def, owner } of this.byName.values()) {
      if (seen.has(def)) continue;
      seen.add(def);
      out.push({ ...def, owner });
    }
    return out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  }
}
