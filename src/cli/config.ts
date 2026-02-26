/**
 * Config type, load/save, port utilities, ask() helper.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { isValidPort } from "../validation.js";
import { print, dim, yellow } from "./formatting.js";

const IS_MACOS = platform() === "darwin";
const IS_LINUX = platform() === "linux";

export const WOLFPACK_DIR = join(homedir(), ".wolfpack");
export const CONFIG_PATH = join(WOLFPACK_DIR, "config.json");

export interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

export let hasTTY = true;

export function ask(question: string): string {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    hasTTY = false;
    return "";
  }
  const n = readSync(fd, buf, 0, buf.length, null);
  closeSync(fd);
  return buf.subarray(0, n).toString("utf-8").trim();
}

export function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveConfig(c: Config) {
  mkdirSync(WOLFPACK_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

export function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isPortInUse(port: number): boolean {
  try {
    const p = Math.floor(Number(port));
    if (!isValidPort(p)) return false;
    if (IS_MACOS) {
      const out = execFileSync("lsof", ["-i", `:${p}`, "-t"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.length > 0;
    } else {
      const out = execFileSync("ss", ["-tlnp", "sport", "=", `:${p}`], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.split("\n").length > 1;
    }
  } catch {
    return false;
  }
}

export function killPortHolder(port: number): boolean {
  try {
    const p = Math.floor(Number(port));
    if (!isValidPort(p)) return false;
    let pid: number | null = null;
    if (IS_MACOS) {
      const out = execFileSync("lsof", ["-i", `:${p}`, "-t"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      pid = out ? Number(out.split("\n")[0]) : null;
    } else {
      const out = execFileSync("ss", ["-tlnp", "sport", "=", `:${p}`], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const m = out.match(/pid=(\d+)/);
      pid = m ? Number(m[1]) : null;
    }
    if (pid && pid > 1) {
      process.kill(pid, "SIGTERM");
      print(dim(`  Killed stale process (PID ${pid}) on port ${p}`));
      return true;
    }
  } catch {}
  return false;
}

export function waitForPortFree(port: number, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPortInUse(port)) return;
    sleepSync(500);
  }
  print(yellow(`  Warning: port ${port} still in use after ${timeoutMs / 1000}s`));
}

export function remoteUrl(config: Config): string | null {
  if (!config.tailscaleHostname) return null;
  return `https://${config.tailscaleHostname}`;
}
