// M6 entry point: node src/server.ts <config.json>
import { loadConfig, startFirewall } from "./firewall.ts";

const file = process.argv[2];
if (file === undefined) {
  console.error("usage: node src/server.ts <config.json>");
  process.exit(2);
}
try {
  const running = await startFirewall(loadConfig(file), { configPath: file });
  console.log(`agent-spend-firewall listening on http://${running.host}:${running.port}`);
  const stop = () => { void running.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  // Never print config contents; the message names the problem only.
  console.error(`startup failed: ${e instanceof Error ? e.message : "unknown error"}`);
  process.exit(1);
}
