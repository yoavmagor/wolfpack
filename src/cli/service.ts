/**
 * Service management — launchd (macOS) and systemd (Linux).
 */
import { execSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { xmlEsc, systemdEsc } from "../validation.js";
import { errMsg } from "../shared/process-cleanup.js";
import { print, bold, green, red, dim } from "./formatting.js";
import {
  WOLFPACK_DIR,
  loadConfig,
  isPortInUse,
  killPortHolder,
  waitForPortFree,
  type Config,
} from "./config.js";

const IS_MACOS = platform() === "darwin";
const IS_LINUX = platform() === "linux";

import pkg from "../../package.json";
const VERSION: string = pkg.version;

const PLIST_LABEL = "com.wolfpack.server";
const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`,
);
const SYSTEMD_SERVICE = "wolfpack";
const SYSTEMD_PATH = join(
  homedir(),
  ".config",
  "systemd",
  "user",
  `${SYSTEMD_SERVICE}.service`,
);

function programArgs(): string[] {
  const exe = process.execPath;
  const isBunRuntime = exe.endsWith("/bun") || exe.endsWith("/bun.exe");
  if (isBunRuntime && process.argv[1]) {
    return [exe, resolve(process.argv[1])];
  }
  const stableBin = join(WOLFPACK_DIR, "bin", "wolfpack");
  if (exe !== stableBin && existsSync(exe)) {
    try {
      mkdirSync(join(WOLFPACK_DIR, "bin"), { recursive: true });
      copyFileSync(exe, stableBin);
      chmodSync(stableBin, 0o755);
      return [stableBin];
    } catch (e: unknown) {
      console.warn(`programArgs: failed to copy binary to stable location:`, errMsg(e));
    }
  }
  return [exe];
}

/**
 * Copies the currently-running binary to ~/.wolfpack/bin/wolfpack if it
 * differs from what's already there.  Returns true when the stable binary
 * was actually replaced (i.e. an upgrade happened).
 */
export function updateStableBinary(): boolean {
  const exe = process.execPath;
  if (exe.endsWith("/bun") || exe.endsWith("/bun.exe")) return false;

  const stableBin = join(WOLFPACK_DIR, "bin", "wolfpack");
  if (exe === stableBin) return false;
  if (!existsSync(exe)) return false;

  try {
    if (existsSync(stableBin)) {
      const a = statSync(exe).size;
      const b = statSync(stableBin).size;
      if (a === b && readFileSync(exe).equals(readFileSync(stableBin))) {
        return false;
      }
    }
    mkdirSync(join(WOLFPACK_DIR, "bin"), { recursive: true });
    copyFileSync(exe, stableBin);
    chmodSync(stableBin, 0o755);
    return true;
  } catch {
    return false;
  }
}

export function renderPlist(config: Config | null, args: string[], logPath: string): string {
  const env: Record<string, string> = { WOLFPACK_SERVICE: "1" };
  if (config?.devDir) env.WOLFPACK_DEV_DIR = config.devDir;
  if (config?.port) env.WOLFPACK_PORT = String(config.port);

  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${xmlEsc(k)}</key>\n      <string>${xmlEsc(v)}</string>`)
    .join("\n");

  const safeLogPath = xmlEsc(logPath);
  const argsXml = args.map(a => `    <string>${xmlEsc(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEsc(PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin</string>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${safeLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${safeLogPath}</string>
</dict>
</plist>`;
}

export function generatePlist(): string {
  return renderPlist(
    loadConfig(),
    programArgs(),
    join(homedir(), ".wolfpack", "wolfpack.log"),
  );
}

export function renderSystemdUnit(config: Config | null, args: string[]): string {
  const envLines: string[] = [
    `Environment=PATH=/usr/local/bin:/usr/bin:/bin`,
    `Environment=WOLFPACK_SERVICE=1`,
  ];
  if (config?.devDir) envLines.push(`Environment="WOLFPACK_DEV_DIR=${systemdEsc(config.devDir)}"`);
  if (config?.port) envLines.push(`Environment="WOLFPACK_PORT=${config.port}"`);

  const quotedArgs = args.map(a => `"${systemdEsc(a)}"`).join(" ");
  return `[Unit]
Description=Wolfpack AI Agent Bridge
After=network.target

[Service]
Type=simple
ExecStart=${quotedArgs}
Restart=always
RestartSec=5
${envLines.join("\n")}

[Install]
WantedBy=default.target
`;
}

export function generateSystemdUnit(): string {
  return renderSystemdUnit(loadConfig(), programArgs());
}

// launchd domain target for the current user
const LAUNCHD_DOMAIN = `gui/${process.getuid!()}`;
const LAUNCHD_TARGET = `${LAUNCHD_DOMAIN}/${PLIST_LABEL}`;

function launchdBootout() {
  try {
    execSync(`launchctl bootout ${LAUNCHD_TARGET} 2>/dev/null`);
  } catch {
    // fallback: pre-1.4 versions used deprecated `launchctl load`, which
    // `bootout` can't always remove — try the legacy unload path
    try {
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } catch (e: unknown) {
      console.warn(`launchdBootout: legacy unload also failed:`, errMsg(e));
    }
  }
}

function launchdBootstrap() {
  execSync(`launchctl bootstrap ${LAUNCHD_DOMAIN} "${PLIST_PATH}"`);
  execSync(`launchctl kickstart ${LAUNCHD_TARGET}`);
}

export function isServiceInstalled(): boolean {
  if (IS_MACOS) return existsSync(PLIST_PATH);
  if (IS_LINUX) return existsSync(SYSTEMD_PATH);
  return false;
}

export function serviceInstall() {
  const config = loadConfig();
  if (!config) {
    print(red("  Run 'wolfpack setup' first."));
    process.exit(1);
  }

  if (isServiceRunning()) {
    serviceStop();
  }
  if (isPortInUse(config.port)) {
    waitForPortFree(config.port);
  }

  if (IS_MACOS) {
    const plist = generatePlist();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(PLIST_PATH, plist);
    launchdBootout();
    launchdBootstrap();
    print("");
    print(green("  Wolfpack service installed and started."));
    print(dim(`  Plist: ${PLIST_PATH}`));
  } else if (IS_LINUX) {
    const unit = generateSystemdUnit();
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    writeFileSync(SYSTEMD_PATH, unit);
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`);
    execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);
    try {
      const user = process.env.USER || "";
      if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
        print(dim("  Note: Could not validate USER for linger. Skipping."));
      } else {
        execFileSync("sudo", ["loginctl", "enable-linger", user]);
      }
    } catch {
      print(dim("  Note: Could not enable linger. Service may not start at boot."));
      print(dim("  Run: sudo loginctl enable-linger $USER"));
    }
    print("");
    print(green("  Wolfpack service installed and started."));
    print(dim(`  Unit: ${SYSTEMD_PATH}`));
  } else {
    print(red("  Service install not supported on this platform."));
    process.exit(1);
  }

  print(dim(`  Log:   ~/.wolfpack/wolfpack.log`));
  print("");
  print("  Wolfpack will now start automatically on login.");
  print(`  Use ${bold("wolfpack service stop")} to stop.`);
  print(`  Use ${bold("wolfpack service uninstall")} to remove.`);
  print("");
}

export function serviceUninstall() {
  if (IS_MACOS) {
    launchdBootout();
    try { unlinkSync(PLIST_PATH); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn(`serviceUninstall: failed to remove plist:`, errMsg(e));
    }
  } else if (IS_LINUX) {
    try { execSync(`systemctl --user stop ${SYSTEMD_SERVICE} 2>/dev/null`); } catch { /* expected: exits non-zero when service not running */ }
    try { execSync(`systemctl --user disable ${SYSTEMD_SERVICE} 2>/dev/null`); } catch { /* expected: exits non-zero when already disabled */ }
    try { unlinkSync(SYSTEMD_PATH); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn(`serviceUninstall: failed to remove unit file:`, errMsg(e));
    }
    try { execSync("systemctl --user daemon-reload"); } catch (e: unknown) {
      console.warn(`serviceUninstall: failed to reload systemd daemon:`, errMsg(e));
    }
  }
  print(green("  Wolfpack service removed."));
}

export function serviceStop() {
  try {
    if (IS_MACOS) {
      launchdBootout();
    } else if (IS_LINUX) {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE}`);
    }
    print(green("  Wolfpack service stopped."));
  } catch {
    print(red("  Failed to stop service."));
  }
  const config = loadConfig();
  if (config && isPortInUse(config.port)) {
    killPortHolder(config.port);
    waitForPortFree(config.port, 5000);
  }
}

export function serviceStart() {
  const config = loadConfig();
  if (config && isPortInUse(config.port)) {
    killPortHolder(config.port);
    waitForPortFree(config.port, 5000);
  }
  try {
    if (IS_MACOS) {
      launchdBootstrap();
    } else if (IS_LINUX) {
      execSync(`systemctl --user start ${SYSTEMD_SERVICE}`);
    }
    print(green("  Wolfpack service started."));
  } catch {
    print(red("  Failed to start service."));
  }
}

export function isServiceRunning(): boolean {
  try {
    if (IS_MACOS) {
      const out = execSync(`launchctl print ${LAUNCHD_TARGET} 2>&1`, { encoding: "utf-8" });
      return /pid\s*=\s*\d+/i.test(out);
    } else if (IS_LINUX) {
      const out = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE} 2>&1`, { encoding: "utf-8" }).trim();
      return out === "active";
    }
  } catch { /* expected: command exits non-zero when service inactive */ }
  return false;
}

export function serviceStatus() {
  print(dim(`  Version: ${VERSION}`));
  if (IS_MACOS) {
    try {
      const out = execSync(`launchctl print ${LAUNCHD_TARGET} 2>&1`, { encoding: "utf-8" });
      const pidMatch = out.match(/pid\s*=\s*(\d+)/i);
      if (pidMatch) {
        print(green(`  Wolfpack is running (PID ${pidMatch[1]})`));
      } else {
        print(dim("  Wolfpack service is loaded but not running."));
      }
    } catch {
      if (existsSync(PLIST_PATH)) {
        print(dim("  Wolfpack service is installed but not loaded."));
      } else {
        print(dim("  Wolfpack service is not installed."));
      }
    }
  } else if (IS_LINUX) {
    try {
      const out = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE} 2>&1`, { encoding: "utf-8" }).trim();
      if (out === "active") {
        const pidOut = execSync(
          `systemctl --user show ${SYSTEMD_SERVICE} --property=MainPID --value`,
          { encoding: "utf-8" },
        ).trim();
        print(green(`  Wolfpack is running (PID ${pidOut})`));
      } else {
        print(dim(`  Wolfpack service status: ${out}`));
      }
    } catch {
      if (existsSync(SYSTEMD_PATH)) {
        print(dim("  Wolfpack service is installed but not running."));
      } else {
        print(dim("  Wolfpack service is not installed."));
      }
    }
  } else {
    print(dim("  Service status not supported on this platform."));
  }
}

export function uninstall() {
  serviceUninstall();
  try { rmSync(WOLFPACK_DIR, { recursive: true, force: true }); } catch (e: unknown) {
    console.warn(`uninstall: failed to remove ${WOLFPACK_DIR}:`, errMsg(e));
  }
  print("");
  print(green("  Wolfpack uninstalled."));
  print(dim(`  Removed ${WOLFPACK_DIR}`));
  print("");
  print(dim("  The wolfpack binary remains at: " + process.execPath));
  print(dim("  Delete it manually if you want a full removal."));
  print("");
}
