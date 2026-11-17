// Pre-commit check: refuse staged content that looks like a secret.
// Not a complete scanner. Keys must never be written inside this repository in the first place.
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" }).split("\n").filter(Boolean);
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
  [/\b(PRIVATE_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE)\s*[=:]\s*["']?[^\s"']{16,}/i, "secret assignment"],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/, "GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/, "base58 string of Solana secret-key length"],
  [/\[(\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/, "64-byte array (Solana keypair file)"],
];
const BAD_NAMES = [/\.env($|\.)/, /keypair.*\.json$/i, /\.(pem|key)$/i, /state.*\.(db|sqlite)$/i];
let bad = 0;
for (const f of files) {
  if (BAD_NAMES.some(r => r.test(f))) { console.error(`secret-scan: refusing file name ${f}`); bad++; continue; }
  let text; try { text = execFileSync("git", ["show", `:${f}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { continue; }
  for (const [re, what] of RULES) if (re.test(text)) { console.error(`secret-scan: ${what} in ${f}`); bad++; }
}
if (bad) { console.error(`secret-scan: ${bad} problem(s); commit refused`); process.exit(1); }
