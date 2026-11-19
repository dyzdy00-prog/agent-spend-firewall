// Builds docs/policy.js: the real policy engine (src/policy.ts) with types stripped,
// wrapped as a classic script so the landing page demo runs the same code as the firewall.
// Run: node scripts/build-site.mjs   (CI checks the output is up to date: --check)
import { stripTypeScriptTypes } from "node:module";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/policy.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(src)
  .replace(/^import type[^\n]*\n/m, "")
  .replace(/^export /gm, "");
const names = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
const out =
  "// GENERATED from src/policy.ts by scripts/build-site.mjs — do not edit.\n" +
  "window.ASFPolicy = (function () {\n" + js + "\nreturn { " + names.join(", ") + " };\n})();\n";
// The public demo console: src/console.html with an in-browser backend switched on.
const consoleSrc = fs.readFileSync(new URL("../src/console.html", import.meta.url), "utf8");
if (!consoleSrc.includes("<!--DEMO-->")) throw new Error("src/console.html lost its <!--DEMO--> marker");
const consoleOut = consoleSrc
  .replace("<!--DEMO-->", '<script>window.ASF_DEMO = true;</script>\n<script src="../policy.js"></script>')
  .replace('<a class="brand" href="./">', '<a class="brand" href="../">')
  .replace("<title>Console · Agent Spend Firewall</title>", "<title>Demo console · Agent Spend Firewall</title>");
const consoleTarget = new URL("../docs/console/index.html", import.meta.url);
const target = new URL("../docs/policy.js", import.meta.url);
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (cur !== out) { console.error("docs/policy.js is stale: run node scripts/build-site.mjs"); process.exit(1); }
  const curC = fs.existsSync(consoleTarget) ? fs.readFileSync(consoleTarget, "utf8") : "";
  if (curC !== consoleOut) { console.error("docs/console/index.html is stale: run node scripts/build-site.mjs"); process.exit(1); }
  console.log("docs/policy.js is up to date");
} else {
  fs.writeFileSync(target, out);
  fs.mkdirSync(new URL("../docs/console/", import.meta.url), { recursive: true });
  fs.writeFileSync(consoleTarget, consoleOut);
  console.log("wrote docs/policy.js", out.length, "bytes; exports:", names.join(", "));
}
