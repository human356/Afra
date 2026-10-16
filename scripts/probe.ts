import { probeFeatures } from "../src/core/features";
import { libInfo } from "../src/core/library";

const r = probeFeatures(libInfo());
console.log(JSON.stringify({ library: r.library, summary: r.summary }, null, 2));
for (const f of r.features) if (f.status !== "supported") console.log(f.status.padEnd(12), f.id.padEnd(20), f.missing.join(", ") || f.note);
