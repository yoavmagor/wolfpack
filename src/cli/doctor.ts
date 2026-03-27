/**
 * `wolfpack doctor` — system health check with optional --fix.
 */
import { execFileSync, execSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { print, bold, green, red, dim, yellow } from "./formatting.js";
import {
  WOLFPACK_DIR,
  IS_MACOS,
  IS_LINUX,
  loadConfig,
  isPortInUse,
  killPortHolder,
  tailscaleBin,
} from "./config.js";
import {
  isServiceInstalled,
  isServiceRunning,
  serviceStart,
} from "./service.js";

export interface CheckResult {
  name: string;
  group: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  fixHint?: string;
  fix?: () => void;
}

type CheckFn = (fix: boolean) => CheckResult[];

// ---------------------------------------------------------------------------
// Check group 1: Dependencies
// ---------------------------------------------------------------------------

function checkDeps(): CheckResult[] {
  const results: CheckResult[] = [];

  // tmux
  try {
    const ver = execSync("tmux -V", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = ver.match(/(\d+\.\d+)/);
    if (match && parseFloat(match[1]) >= 3.0) {
      results.push({ name: "tmux", group: "Dependencies", status: "pass", detail: ver });
    } else {
      results.push({
        name: "tmux", group: "Dependencies", status: "fail",
        detail: `${ver} (need >= 3.0)`,
        fixHint: IS_MACOS ? "brew install tmux" : "sudo apt install tmux",
      });
    }
  } catch {
    results.push({
      name: "tmux", group: "Dependencies", status: "fail", detail: "not found",
      fixHint: IS_MACOS ? "brew install tmux" : "sudo apt install tmux",
    });
  }

  // tailscale
  const tsBin = tailscaleBin();
  if (tsBin) {
    try {
      const ver = execSync(`${tsBin} version`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split("\n")[0];
      results.push({ name: "tailscale", group: "Dependencies", status: "pass", detail: ver });
    } catch {
      results.push({ name: "tailscale", group: "Dependencies", status: "pass", detail: "installed" });
    }

    // tailscale connected?
    const sudoPrefix = IS_LINUX ? "sudo " : "";
    try {
      const status = execSync(`${sudoPrefix}${tsBin} status --self --json`, {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(status);
      const hostname = parsed.Self?.DNSName?.replace(/\.$/, "");
      if (hostname) {
        results.push({ name: "tailscale connected", group: "Dependencies", status: "pass", detail: hostname });
      } else {
        results.push({
          name: "tailscale connected", group: "Dependencies", status: "warn",
          detail: "not connected", fixHint: "tailscale up",
        });
      }
    } catch {
      results.push({
        name: "tailscale connected", group: "Dependencies", status: "warn",
        detail: "unable to query status", fixHint: "tailscale up",
      });
    }
  } else {
    results.push({
      name: "tailscale", group: "Dependencies", status: "fail", detail: "not found",
      fixHint: IS_MACOS ? "brew install --cask tailscale" : "curl -fsSL https://tailscale.com/install.sh | sh",
    });
  }

  // SHELL
  const shell = process.env.SHELL;
  if (shell && existsSync(shell)) {
    results.push({ name: "shell", group: "Dependencies", status: "pass", detail: shell });
  } else {
    results.push({
      name: "shell", group: "Dependencies", status: "warn",
      detail: shell ? `${shell} (not found)` : "SHELL not set",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 2: Config
// ---------------------------------------------------------------------------

function checkConfig(): CheckResult[] {
  const results: CheckResult[] = [];

  // ~/.wolfpack/ exists
  if (existsSync(WOLFPACK_DIR)) {
    results.push({ name: "~/.wolfpack/", group: "Config", status: "pass", detail: "exists" });
  } else {
    results.push({
      name: "~/.wolfpack/", group: "Config", status: "fail", detail: "missing",
      fixHint: "wolfpack setup",
      fix: () => mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 }),
    });
  }

  // config.json
  const config = loadConfig();
  if (config) {
    results.push({
      name: "config.json", group: "Config", status: "pass",
      detail: `port=${config.port}, devDir=${config.devDir}`,
    });
  } else {
    results.push({
      name: "config.json", group: "Config", status: "fail",
      detail: existsSync(join(WOLFPACK_DIR, "config.json")) ? "parse error" : "missing",
      fixHint: "wolfpack setup",
    });
    return results; // can't check devDir without config
  }

  // devDir
  if (existsSync(config.devDir)) {
    try {
      accessSync(config.devDir, fsConstants.R_OK);
      results.push({ name: "devDir", group: "Config", status: "pass", detail: config.devDir });
    } catch {
      results.push({
        name: "devDir", group: "Config", status: "fail",
        detail: `${config.devDir} (not readable)`,
      });
    }
  } else {
    results.push({
      name: "devDir", group: "Config", status: "fail",
      detail: `${config.devDir} (missing)`,
      fix: () => mkdirSync(config.devDir, { recursive: true }),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 3: Service
// ---------------------------------------------------------------------------

function checkService(): CheckResult[] {
  const results: CheckResult[] = [];
  const config = loadConfig();

  // installed
  if (isServiceInstalled()) {
    results.push({ name: "service installed", group: "Service", status: "pass", detail: IS_MACOS ? "launchd" : "systemd" });
  } else {
    results.push({
      name: "service installed", group: "Service", status: "fail",
      detail: "not installed", fixHint: "wolfpack service install",
    });
    return results;
  }

  // running
  if (isServiceRunning()) {
    results.push({ name: "service running", group: "Service", status: "pass", detail: "active" });
  } else {
    results.push({
      name: "service running", group: "Service", status: "fail",
      detail: "not running",
      fix: () => serviceStart(),
    });
  }

  // port ownership
  if (config) {
    if (isPortInUse(config.port)) {
      if (isServiceRunning()) {
        results.push({ name: `port ${config.port}`, group: "Service", status: "pass", detail: "owned by wolfpack" });
      } else {
        results.push({
          name: `port ${config.port}`, group: "Service", status: "fail",
          detail: "held by another process",
          fix: () => killPortHolder(config.port),
        });
      }
    } else if (isServiceRunning()) {
      results.push({
        name: `port ${config.port}`, group: "Service", status: "warn",
        detail: "service running but port is free (may still be starting)",
      });
    } else {
      results.push({
        name: `port ${config.port}`, group: "Service", status: "warn",
        detail: "port free (service not running)",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 4: Connectivity
// ---------------------------------------------------------------------------

function checkConnectivity(): CheckResult[] {
  const results: CheckResult[] = [];
  const config = loadConfig();
  if (!config) return results;

  // localhost
  try {
    const resp = execSync(
      `curl -sf --max-time 3 http://localhost:${config.port}/api/info`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(resp);
    results.push({
      name: "localhost", group: "Connectivity", status: "pass",
      detail: `v${parsed.version || "?"}`,
    });
  } catch {
    results.push({
      name: "localhost", group: "Connectivity", status: "fail",
      detail: `localhost:${config.port} not responding`,
    });
  }

  // tailscale hostname
  if (config.tailscaleHostname) {
    try {
      execSync(`dig +short ${config.tailscaleHostname} 2>/dev/null`, {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      results.push({
        name: "tailscale hostname", group: "Connectivity", status: "pass",
        detail: config.tailscaleHostname,
      });
    } catch {
      results.push({
        name: "tailscale hostname", group: "Connectivity", status: "warn",
        detail: `${config.tailscaleHostname} (doesn't resolve)`,
        fixHint: "tailscale up",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 5: Binary
// ---------------------------------------------------------------------------

function checkBinary(): CheckResult[] {
  const results: CheckResult[] = [];
  const stableBin = join(WOLFPACK_DIR, "bin", "wolfpack");

  if (existsSync(stableBin)) {
    const size = statSync(stableBin).size;
    const sizeMB = (size / 1024 / 1024).toFixed(1);
    results.push({ name: "binary", group: "Binary", status: "pass", detail: `${sizeMB}MB` });
  } else {
    results.push({
      name: "binary", group: "Binary", status: "fail", detail: "missing",
      fix: () => {
        const exe = process.execPath;
        if (existsSync(exe) && !exe.endsWith("/bun")) {
          mkdirSync(join(WOLFPACK_DIR, "bin"), { recursive: true });
          copyFileSync(exe, stableBin);
          chmodSync(stableBin, 0o755);
        }
      },
    });
    return results;
  }

  // executable
  try {
    accessSync(stableBin, fsConstants.X_OK);
    results.push({ name: "binary executable", group: "Binary", status: "pass", detail: "yes" });
  } catch {
    results.push({
      name: "binary executable", group: "Binary", status: "fail", detail: "not executable",
      fix: () => chmodSync(stableBin, 0o755),
    });
  }

  // codesign (macOS)
  if (IS_MACOS) {
    try {
      execFileSync("codesign", ["-v", stableBin], { stdio: "ignore" });
      results.push({ name: "codesign", group: "Binary", status: "pass", detail: "valid" });
    } catch {
      results.push({
        name: "codesign", group: "Binary", status: "fail", detail: "invalid or unsigned",
        fix: () => execFileSync("codesign", ["-f", "-s", "-", stableBin], { stdio: "ignore" }),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 6: tmux runtime
// ---------------------------------------------------------------------------

function checkTmuxRuntime(): CheckResult[] {
  const results: CheckResult[] = [];

  // list sessions
  try {
    const out = execSync("tmux list-sessions 2>/dev/null", {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const count = out ? out.split("\n").length : 0;
    results.push({
      name: "tmux sessions", group: "tmux Runtime", status: "pass",
      detail: `${count} active`,
    });
  } catch {
    results.push({
      name: "tmux sessions", group: "tmux Runtime", status: "pass",
      detail: "no sessions (server not running)",
    });
  }

  // create + kill throwaway
  const testSession = "_wolfpack_doctor";
  try {
    execSync(`tmux new-session -d -s ${testSession} 2>/dev/null`, { stdio: "ignore" });
    execSync(`tmux kill-session -t ${testSession} 2>/dev/null`, { stdio: "ignore" });
    results.push({ name: "tmux create/destroy", group: "tmux Runtime", status: "pass", detail: "ok" });
  } catch {
    results.push({
      name: "tmux create/destroy", group: "tmux Runtime", status: "fail",
      detail: "failed to create test session",
    });
    // cleanup in case creation succeeded but kill failed
    try { execSync(`tmux kill-session -t ${testSession} 2>/dev/null`, { stdio: "ignore" }); } catch { /* noop */ }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 7: Environment
// ---------------------------------------------------------------------------

function checkEnvironment(): CheckResult[] {
  const results: CheckResult[] = [];
  const pathDirs = (process.env.PATH || "").split(":");

  const expectedDirs = IS_MACOS
    ? ["/opt/homebrew/bin", "/usr/local/bin"]
    : ["/usr/local/bin"];

  for (const dir of expectedDirs) {
    if (pathDirs.includes(dir)) {
      results.push({ name: `PATH includes ${dir}`, group: "Environment", status: "pass", detail: "yes" });
    } else {
      results.push({ name: `PATH includes ${dir}`, group: "Environment", status: "warn", detail: "missing" });
    }
  }

  if (process.env.HOME) {
    results.push({ name: "HOME", group: "Environment", status: "pass", detail: process.env.HOME });
  } else {
    results.push({ name: "HOME", group: "Environment", status: "warn", detail: "not set" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check group 8: Logs
// ---------------------------------------------------------------------------

function checkLogs(): CheckResult[] {
  const results: CheckResult[] = [];
  const logPath = join(WOLFPACK_DIR, "wolfpack.log");

  if (!existsSync(logPath)) {
    results.push({ name: "wolfpack.log", group: "Logs", status: "pass", detail: "not created yet" });
    return results;
  }

  const stat = statSync(logPath);
  const sizeKB = (stat.size / 1024).toFixed(0);
  const agoMs = Date.now() - stat.mtimeMs;
  const ago = agoMs < 60000 ? `${Math.round(agoMs / 1000)}s ago`
    : agoMs < 3600000 ? `${Math.round(agoMs / 60000)}m ago`
    : `${Math.round(agoMs / 3600000)}h ago`;
  results.push({ name: "wolfpack.log", group: "Logs", status: "pass", detail: `${sizeKB}KB, modified ${ago}` });

  // recent errors
  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");
    const tail = lines.slice(-100);
    const errorLines = tail.filter(l => /\b(error|fatal|crash|SIGKILL|panic)\b/i.test(l));
    if (errorLines.length === 0) {
      results.push({ name: "recent errors", group: "Logs", status: "pass", detail: "none" });
    } else {
      const last = errorLines.slice(-3).map(l => l.trim().slice(0, 100));
      results.push({
        name: "recent errors", group: "Logs", status: "warn",
        detail: `${errorLines.length} error(s) in last 100 lines`,
      });
      for (const line of last) {
        results.push({ name: "", group: "Logs", status: "warn", detail: line });
      }
    }
  } catch {
    results.push({ name: "recent errors", group: "Logs", status: "warn", detail: "unable to read log" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<CheckResult["status"], string> = {
  pass: green("✓"),
  fail: red("✗"),
  warn: yellow("⚠"),
};

function printResults(results: CheckResult[]): { pass: number; fail: number; warn: number } {
  const counts = { pass: 0, fail: 0, warn: 0 };
  let currentGroup = "";

  for (const r of results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      print("");
      print(bold(`  ${currentGroup}`));
    }
    counts[r.status]++;
    const icon = STATUS_ICONS[r.status];
    if (r.name) {
      print(`    ${icon} ${r.name}${r.detail ? dim(` — ${r.detail}`) : ""}`);
    } else {
      // continuation line (e.g. error log excerpts)
      print(`      ${dim(r.detail)}`);
    }
    if (r.status === "fail" && r.fixHint) {
      print(dim(`      → ${r.fixHint}`));
    }
  }

  return counts;
}

export function doctor() {
  const doFix = process.argv.includes("--fix");

  const checkGroups: CheckFn[] = [
    checkDeps,
    checkConfig,
    checkService,
    checkConnectivity,
    checkBinary,
    checkTmuxRuntime,
    checkEnvironment,
    checkLogs,
  ];

  let allResults: CheckResult[] = [];
  for (const group of checkGroups) {
    allResults.push(...group(doFix));
  }

  // --fix: attempt fixes then re-run failed checks
  if (doFix) {
    const fixable = allResults.filter(r => r.status === "fail" && r.fix);
    if (fixable.length > 0) {
      print(bold("\n  Attempting fixes..."));
      for (const r of fixable) {
        try {
          r.fix!();
          print(`    ${green("✓")} fixed: ${r.name}`);
        } catch (e) {
          print(`    ${red("✗")} fix failed: ${r.name} — ${e}`);
        }
      }
      // re-run all checks after fixes
      allResults = [];
      for (const group of checkGroups) {
        allResults.push(...group(doFix));
      }
    }
  }

  const counts = printResults(allResults);
  const total = counts.pass + counts.fail + counts.warn;

  print("");
  if (counts.fail === 0) {
    print(green(`  Result: ${counts.pass}/${total} passed`) +
      (counts.warn > 0 ? yellow(`, ${counts.warn} warning(s)`) : ""));
  } else {
    print(red(`  Result: ${counts.fail} failed`) +
      `, ${counts.pass} passed` +
      (counts.warn > 0 ? yellow(`, ${counts.warn} warning(s)`) : ""));
    if (!doFix) {
      const fixableCount = allResults.filter(r => r.status === "fail" && r.fix).length;
      if (fixableCount > 0) {
        print(dim(`  Run ${bold("wolfpack doctor --fix")} to auto-fix ${fixableCount} issue(s).`));
      }
    }
  }
  print("");

  return counts.fail > 0 ? 1 : 0;
}
