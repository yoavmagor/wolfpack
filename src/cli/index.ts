#!/usr/bin/env bun
/**
 * CLI dispatch entry point.
 */
import { printQR } from "../qr.js";
import { print, bold, dim, red, yellow, WOLF } from "./formatting.js";
import {
  loadConfig,
  isPortInUse,
  remoteUrl,
  type Config,
} from "./config.js";
import {
  serviceInstall,
  serviceUninstall,
  serviceStop,
  serviceStart,
  serviceStatus,
  isServiceRunning,
  uninstall,
} from "./service.js";
import { setup } from "./setup.js";

export {
  loadConfig,
  saveConfig,
  isPortInUse,
  killPortHolder,
  type Config,
} from "./config.js";
export { generatePlist, generateSystemdUnit } from "./service.js";

async function start() {
  let config = loadConfig();
  if (!config) {
    print("  No config found. Running setup first...\n");
    await setup();
    process.exit(0);
  }

  // Service daemon mode — just start the server
  if (process.env.WOLFPACK_SERVICE === "1") {
    process.env.WOLFPACK_DEV_DIR = config.devDir;
    process.env.WOLFPACK_PORT = String(config.port);
    await import("../server/index.js");
    return;
  }

  // CLI invocation — ensure service is running
  const url = remoteUrl(config);
  const wasRunning = isServiceRunning();
  try {
    serviceInstall();
  } catch (e) {
    print(red(`  Service install failed: ${e}`));
    print(dim("  Run 'wolfpack service install' to retry."));
  }
  if (wasRunning && !isServiceRunning()) {
    print(yellow("  Service was running but didn't restart."));
    print(yellow(`  Run ${bold("wolfpack service start")} to restart it.`));
  }

  print(dim(WOLF));
  print(bold("  WOLFPACK"));
  print("");
  print(`  Local:    ${dim(`http://localhost:${config.port}/`)}`);
  if (url) print(`  Remote:   ${dim(url)}`);
  print("");
  print(dim("  Scan to open on your phone:"));
  print("");
  printQR(url ?? `http://localhost:${config.port}/`);
  print("");
}

const cmd = process.argv[2];
const subcmd = process.argv[3];

async function main() {
  if (cmd === "setup") {
    await setup();
  } else if (cmd === "service") {
    if (subcmd === "install") serviceInstall();
    else if (subcmd === "uninstall") serviceUninstall();
    else if (subcmd === "stop") serviceStop();
    else if (subcmd === "start") serviceStart();
    else if (subcmd === "status") serviceStatus();
    else {
      print("  Usage: wolfpack service [install|uninstall|start|stop|status]");
    }
  } else if (cmd === "uninstall") {
    uninstall();
  } else if (cmd === "worker") {
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    await import("../ralph-macchio.js");
  } else {
    await start();
  }
}

// only run when executed directly, not when imported for tests
if (import.meta.main) {
  main().catch((e) => {
    print(red(`  Fatal error: ${e.message || e}`));
    process.exit(1);
  });
}
