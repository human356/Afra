// Copies non-TypeScript runtime assets (dashboard static files) into dist/.
const fs = require("node:fs");
const path = require("node:path");
const from = path.join(__dirname, "..", "src", "dashboard", "public");
const to = path.join(__dirname, "..", "dist", "dashboard", "public");
fs.mkdirSync(to, { recursive: true });
fs.cpSync(from, to, { recursive: true });
console.error(`copied dashboard assets -> ${path.relative(process.cwd(), to)}`);
