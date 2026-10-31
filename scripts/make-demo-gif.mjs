// Records docs/demo.gif: a real garden growing, followed by a slow camera turn.
//
//   npm run demo:gif            (builds, then runs this script)
//   DEMO_USER=octocat npm run demo:gif
//
// Needs a local Chrome/Chromium (set CHROME_PATH if it isn't found) and ffmpeg.
// The page runs on a virtual clock that advances exactly 1/FPS per captured frame,
// so the GIF is smooth even when (software) rendering is much slower than real time.
//
// With --og it instead saves the social preview image, public/og.png (1200×630), from
// capture mode (?demo=<seed>&capture=1). No ffmpeg or network needed:
//
//   npm run og
//   OG_SEED=36 npm run og       (try another demo seed)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'docs', 'demo.gif');
const USER = process.env.DEMO_USER || 'torvalds';

const OG_MODE = process.argv.includes('--og');
const OG_OUTPUT = path.join(ROOT, 'public', 'og.png');
// Seed 10 is the densest of demo seeds 1–60 (Forest rank, ~80% of days active, evenly spread).
const OG_SEED = process.env.OG_SEED || '10';
const OG_QUERY = `?demo=${encodeURIComponent(OG_SEED)}&capture=1`;
const OG_VIEWPORT = { width: 1200, height: 630 };

const FPS = 15;
const SECONDS = 6;
const FRAMES = FPS * SECONDS;
const VIEWPORT = { width: 1200, height: 675 };
const GIF_WIDTH = 800;
const MAX_BYTES = 5 * 1024 * 1024;

// The fly-in ends at ~2.4 s; from there a gentle drag turns the camera back toward a
// front view, which keeps the long island inside the frame (and clear of the HUD).
const DRAG_FROM_FRAME = 40;
const DRAG_PX_PER_FRAME = 0.9;
const DRAG_START = { x: VIEWPORT.width / 2, y: 110 }; // empty sky above the island

// Tried in order until the GIF fits under MAX_BYTES.
const ENCODINGS = [
  { colors: 256, dither: 'bayer:bayer_scale=4' },
  { colors: 192, dither: 'bayer:bayer_scale=5' },
  { colors: 128, dither: 'none' },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!found) throw new Error('Chrome/Chromium not found. Set CHROME_PATH to its executable.');
  return found;
}

function checkFfmpeg() {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout.includes('palettegen')) {
    throw new Error('ffmpeg (with palettegen/paletteuse) is required. Install it and try again.');
  }
}

/** Runs in the page before any app code: replaces rAF and performance.now with a virtual clock. */
function installVirtualClock() {
  let now = 0;
  let nextId = 1;
  let callbacks = new Map();
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => callbacks.delete(id);
  performance.now = () => now;
  window.__advanceClock = (ms) => {
    now += ms;
    const due = [...callbacks.values()];
    callbacks = new Map();
    for (const cb of due) cb(now);
  };
}

function launchBrowser() {
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
  });
}

/** Screenshots capture mode once the page reports __GARDEN_READY__. */
async function captureOg(url) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.error('page error:', err.message));
    await page.setViewport({ ...OG_VIEWPORT, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__GARDEN_READY__ || window.__GARDEN_ERROR__, { timeout: 60000 });
    const error = await page.evaluate(() => window.__GARDEN_ERROR__);
    if (error) throw new Error(`Capture mode failed: ${error}`);
    await fs.mkdir(path.dirname(OG_OUTPUT), { recursive: true });
    await page.screenshot({ path: OG_OUTPUT });
  } finally {
    await browser.close();
  }
}

async function recordFrames(url, framesDir) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.error('page error:', err.message));
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(installVirtualClock);
    await page.goto(url, { waitUntil: 'networkidle0' });

    // The HUD appears once the data is in and the garden has been built.
    const loaded = await Promise.race([
      page.waitForSelector('#toolbar:not([hidden])', { timeout: 60000 }).then(() => true),
      page.waitForSelector('#error:not([hidden])', { timeout: 60000 }).then(() => false),
    ]);
    if (!loaded) throw new Error(`Couldn't load the garden: ${await page.$eval('#error', (el) => el.textContent)}`);
    await new Promise((resolve) => setTimeout(resolve, 800)); // CSS fades run on real time

    let x = DRAG_START.x;
    for (let i = 0; i < FRAMES; i++) {
      if (i === DRAG_FROM_FRAME) {
        await page.mouse.move(x, DRAG_START.y);
        await page.mouse.down();
      } else if (i > DRAG_FROM_FRAME) {
        x += DRAG_PX_PER_FRAME;
        await page.mouse.move(x, DRAG_START.y);
      }
      await page.evaluate((ms) => window.__advanceClock(ms), 1000 / FPS);
      await page.screenshot({ path: path.join(framesDir, `frame-${String(i).padStart(3, '0')}.png`) });
      process.stdout.write(`\r  frame ${i + 1}/${FRAMES}`);
    }
    process.stdout.write('\n');
  } finally {
    await browser.close();
  }
}

function encodeGif(framesDir, target, { colors, dither }) {
  const filter =
    `scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=${colors}:stats_mode=diff[p];` +
    `[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`;
  const res = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(framesDir, 'frame-%03d.png'), '-vf', filter, '-loop', '0', target],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error('ffmpeg failed to encode the GIF.');
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('No build found in dist/. Run `npm run build` first (or use `npm run demo:gif` / `npm run og`).');
  }

  if (OG_MODE) {
    const server = await preview({ root: ROOT, base: './', logLevel: 'error', preview: { port: 4180, open: false } });
    try {
      const url = new URL(OG_QUERY, server.resolvedUrls.local[0]).href;
      console.log(`Capturing ${url}`);
      await captureOg(url);
      console.log(`Saved ${path.relative(ROOT, OG_OUTPUT)}`);
    } finally {
      await server.close();
    }
    return;
  }

  checkFfmpeg();

  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-garden-gif-'));
  const server = await preview({ root: ROOT, base: './', logLevel: 'error', preview: { port: 4180, open: false } });
  try {
    const url = new URL(`?user=${encodeURIComponent(USER)}`, server.resolvedUrls.local[0]).href;
    console.log(`Recording ${FRAMES} frames of ${url}`);
    await recordFrames(url, framesDir);

    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    const draft = path.join(framesDir, 'demo.gif');
    for (const encoding of ENCODINGS) {
      encodeGif(framesDir, draft, encoding);
      const { size } = await fs.stat(draft);
      console.log(`  ${encoding.colors} colors, dither ${encoding.dither}: ${(size / 1024 / 1024).toFixed(2)} MB`);
      if (size <= MAX_BYTES) {
        await fs.copyFile(draft, OUTPUT);
        console.log(`Saved ${path.relative(ROOT, OUTPUT)}`);
        return;
      }
    }
    throw new Error(`Couldn't get the GIF under ${MAX_BYTES / 1024 / 1024} MB.`);
  } finally {
    await server.close();
    await fs.rm(framesDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
