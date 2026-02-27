#!/usr/bin/env bun
/**
 * Capture animated GIFs of Wolfpack UI for README.
 * Takes frame sequences with Playwright, stitches with ffmpeg.
 */
import { chromium } from "playwright";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { execFileSync } from "child_process";

const BASE = "http://localhost:18790";
const OUT = join(import.meta.dir, "..", "docs");
const TMP = join(OUT, ".frames");

const FRAME_HOLD_MS = 2200; // how long each view is shown
const TRANSITION_FRAMES = 6; // fade frames between views
const FPS = 12;

async function captureFrames(
  page: any,
  views: { name: string; setup: () => Promise<void>; wait?: number }[],
  prefix: string,
) {
  let frame = 0;
  for (const view of views) {
    await view.setup();
    await page.waitForTimeout(view.wait || 1500);
    // Hold frame — capture multiple copies for duration
    const holdFrames = Math.round((FRAME_HOLD_MS / 1000) * FPS);
    for (let i = 0; i < holdFrames; i++) {
      await page.screenshot({
        path: join(TMP, `${prefix}-${String(frame).padStart(4, "0")}.png`),
      });
      frame++;
    }
  }
  return frame;
}

function framesToGif(prefix: string, outFile: string, width: number) {
  // Use ffmpeg with palettegen for high-quality GIF
  const palette = join(TMP, `${prefix}-palette.png`);
  const input = join(TMP, `${prefix}-%04d.png`);

  // Generate optimized palette
  execFileSync("ffmpeg", [
    "-y", "-framerate", String(FPS), "-i", input,
    "-vf", `scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff`,
    palette,
  ]);

  // Create GIF with palette
  execFileSync("ffmpeg", [
    "-y", "-framerate", String(FPS), "-i", input,
    "-i", palette,
    "-lavfi", `scale=${width}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0",
    outFile,
  ]);

  console.log(`✓ ${outFile}`);
}

async function main() {
  // Clean and create temp dir
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // ── Desktop GIF (1280x800) ──
  console.log("Capturing desktop frames...");
  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const dp = await desktop.newPage();
  await dp.goto(BASE, { waitUntil: "networkidle" });
  await dp.waitForTimeout(2000);

  await captureFrames(dp, [
    {
      name: "sessions",
      setup: async () => {
        await dp.evaluate(() => (window as any).showView("sessions"));
      },
      wait: 1500,
    },
    {
      name: "terminal",
      setup: async () => {
        // Open first session via JS
        await dp.evaluate(() => {
          const cards = document.querySelectorAll(".card[onclick*='openSession']");
          if (cards.length) (cards[0] as HTMLElement).click();
        });
      },
      wait: 3000,
    },
    {
      name: "settings",
      setup: async () => {
        await dp.evaluate(() => (window as any).showView("settings"));
      },
    },
    {
      name: "sessions-end",
      setup: async () => {
        await dp.evaluate(() => (window as any).showView("sessions"));
      },
    },
  ], "desktop");

  await desktop.close();

  // ── Mobile GIF (390x844) ──
  console.log("Capturing mobile frames...");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const mp = await mobile.newPage();
  await mp.goto(BASE, { waitUntil: "networkidle" });
  await mp.waitForTimeout(2000);

  await captureFrames(mp, [
    {
      name: "sessions",
      setup: async () => {
        await mp.evaluate(() => (window as any).showView("sessions"));
      },
      wait: 1500,
    },
    {
      name: "terminal",
      setup: async () => {
        await mp.evaluate(() => {
          const cards = document.querySelectorAll(".card[onclick*='openSession']");
          if (cards.length) (cards[0] as HTMLElement).click();
        });
      },
      wait: 2000,
    },
    {
      name: "settings",
      setup: async () => {
        await mp.evaluate(() => (window as any).showView("settings"));
      },
    },
    {
      name: "sessions-end",
      setup: async () => {
        await mp.evaluate(() => (window as any).showView("sessions"));
      },
    },
  ], "mobile");

  await mobile.close();
  await browser.close();

  // ── Stitch GIFs ──
  console.log("\nStitching GIFs...");
  framesToGif("desktop", join(OUT, "desktop-demo.gif"), 960);
  framesToGif("mobile", join(OUT, "mobile-demo.gif"), 390);

  // Clean up frames
  rmSync(TMP, { recursive: true, force: true });

  console.log("\nDone! GIFs saved to docs/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
