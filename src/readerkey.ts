// Where the optional Anthropic API key for the Reader (agents/reader.ts) lives. Write-only from the console:
// state says whether a key is set and where it came from, never the key. The file sits next to the state file, mode 0600.
import fs from "node:fs";

export interface ReaderKeyStatus { configured: boolean; source: "file" | "env" | null }
export interface ReaderKey {
  status(): ReaderKeyStatus;
  /** The key, for the one call that needs it. A key saved in the console wins over the environment. */
  get(): string | null;
  /** null on success, else what is wrong. */
  set(v: unknown): string | null;
  clear(): void;
}

const OK = /^[\x21-\x7e]{20,300}$/;

export function createReaderKey(file: string, env: NodeJS.ProcessEnv = process.env): ReaderKey {
  const fromFile = (): string | null => {
    try {
      const s = fs.readFileSync(file, "utf8").trim();
      return OK.test(s) ? s : null;
    } catch { return null; }
  };
  const fromEnv = (): string | null => {
    const s = (env["ANTHROPIC_API_KEY"] ?? "").trim();
    return OK.test(s) ? s : null;
  };
  return {
    status() {
      if (fromFile() !== null) return { configured: true, source: "file" };
      if (fromEnv() !== null) return { configured: true, source: "env" };
      return { configured: false, source: null };
    },
    get: () => fromFile() ?? fromEnv(),
    set(v) {
      const key = typeof v === "string" ? v.trim() : "";
      if (!OK.test(key)) return "key: 20 to 300 characters, no spaces";
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(tmp, key + "\n", { mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, file);
      } catch {
        fs.rmSync(tmp, { force: true });
        return "cannot write the key file";
      }
      return null;
    },
    clear() { fs.rmSync(file, { force: true }); },
  };
}
