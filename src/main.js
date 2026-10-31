import './style.css';
import { Garden, GROW_DURATION } from './garden.js';
import {
  computeStats,
  fetchContributions,
  GardenError,
  generateDemoData,
  generateEmptyGarden,
  getRank,
  normalizeUsername,
} from './data.js';
import { createUI, formatNumber } from './ui.js';

const THEME_KEY = 'commit-garden:night';
const MOTION_KEY = 'commit-garden:paused';
const CAPTURE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500; // one automatic retry when the API is busy or failing

const ui = createUI();
const cache = new Map(); // lower-cased username → garden data
let garden = null;
let current = null; // { data, stats }
let loadToken = 0;
let controller = null;

/** The app's own URL, without query — works at the domain root and under the Pages subpath. */
const baseUrl = () => `${window.location.origin}${window.location.pathname}`;

function shareUrl(data) {
  return data.isDemo ? `${baseUrl()}?demo=${data.seed}` : `${baseUrl()}?user=${encodeURIComponent(data.username)}`;
}

function syncUrl(data, push) {
  const url = shareUrl(data);
  if (url === window.location.href) return;
  window.history[push ? 'pushState' : 'replaceState'](null, '', url);
}

/** Reads an on/off setting; null when it was never saved (or storage is unavailable). */
function readFlag(key) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

function saveFlag(key, on) {
  try {
    window.localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // Storage can be unavailable (private mode); the toggle still works for this visit.
  }
}

/** Resolves after `ms`, or rejects as "aborted" if the signal fires first. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancelled = () => new GardenError('Request cancelled.', 'aborted');
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(cancelled());
      },
      { once: true },
    );
  });
}

/** fetchContributions with one automatic retry for rate limits and server errors. */
async function fetchWithRetry(username, signal) {
  try {
    return await fetchContributions(username, { signal });
  } catch (err) {
    if (!['rate-limit', 'server'].includes(err?.kind)) throw err;
    await wait(RETRY_DELAY_MS, signal);
    return fetchContributions(username, { signal });
  }
}

function cancelPendingLoad() {
  loadToken++;
  controller?.abort();
  controller = null;
  ui.setLoading(false);
}

// ---- screens -------------------------------------------------------------

function showLanding() {
  ui.showLanding({ canGoBack: Boolean(current) });
  garden.setInteractive(false);
  garden.setInsets(ui.getSafeInsets());
  document.title = 'Commit Garden';
}

/**
 * `focus` is true when the user acted on the landing screen (form, buttons, Escape): that screen is
 * now inert, so keyboard focus moves to the garden. URL routing leaves focus alone.
 */
function backToGarden({ focus = true } = {}) {
  if (!current) return;
  cancelPendingLoad();
  ui.hideLanding();
  garden.setInsets(ui.getSafeInsets());
  garden.setInteractive(true);
  if (focus) garden.focus();
  updateTitle(current.data);
}

function updateTitle(data) {
  document.title = data.isDemo ? 'Demo garden · Commit Garden' : `${data.username} · Commit Garden`;
}

function showGarden(data, { focus = true } = {}) {
  const stats = computeStats(data.days);
  const rank = getRank(stats.total);
  current = { data, stats };
  ui.showGarden({ data, stats, rank, growDuration: GROW_DURATION });
  // Insets go first: setGarden() frames the new garden (and its intro) around the HUD.
  garden.setInsets(ui.getSafeInsets());
  garden.setInteractive(true);
  garden.setGarden(data);
  const who = data.isDemo ? 'Demo garden' : `Garden of @${data.username}`;
  garden.setLabel(
    `${who}: ${formatNumber(stats.total)} contributions in the last year, rank ${rank.name}. ` +
      'Use the arrow keys to inspect days, Escape to clear.',
  );
  if (focus) garden.focus(); // see backToGarden()
  updateTitle(data);
}

// ---- loading -------------------------------------------------------------

async function loadUser(input, { push = true, focus = true } = {}) {
  const username = normalizeUsername(input);
  ui.setInputValue(username || String(input ?? '').trim());
  if (!username) {
    showLanding();
    ui.showError('Type a GitHub username to grow a garden.');
    return;
  }

  cancelPendingLoad();
  const token = loadToken;
  controller = new AbortController();
  ui.hideError();
  ui.setLoading(true);

  try {
    const key = username.toLowerCase();
    const data = cache.get(key) ?? (await fetchWithRetry(username, controller.signal));
    if (token !== loadToken) return;
    cache.set(key, data);
    showGarden(data, { focus });
    syncUrl(data, push);
  } catch (err) {
    if (token !== loadToken || err?.kind === 'aborted') return;
    if (!(err instanceof GardenError)) console.error(err);
    showLanding();
    ui.setInputValue(username);
    ui.showError(err instanceof GardenError ? err.message : 'Something went wrong while growing this garden. Please try again.');
  } finally {
    if (token === loadToken) ui.setLoading(false);
  }
}

function loadDemo(seed, { push = true, focus = true } = {}) {
  cancelPendingLoad();
  const data = Number.isFinite(seed) && seed >= 0 ? generateDemoData(seed) : generateDemoData();
  showGarden(data, { focus });
  syncUrl(data, push);
}

/** Loads whatever the current URL asks for (?user=… or ?demo=…), or shows the landing screen. */
function route() {
  const params = new URLSearchParams(window.location.search);
  const user = params.get('user');
  const demo = params.get('demo');
  if (user) {
    const cached = cache.get(normalizeUsername(user).toLowerCase());
    if (cached && cached === current?.data) {
      backToGarden({ focus: false });
      return;
    }
    showLanding();
    loadUser(user, { push: false, focus: false });
  } else if (demo !== null) {
    loadDemo(Number.parseInt(demo, 10), { push: false, focus: false });
  } else {
    cancelPendingLoad();
    showLanding();
  }
}

// ---- actions -------------------------------------------------------------

async function downloadPng() {
  if (!current) return;
  ui.setBusy('downloadBtn', true);
  try {
    const { data, stats } = current;
    const who = data.isDemo ? 'Demo garden' : `@${data.username}`;
    const caption = `🌱 Commit Garden · ${who} · ${formatNumber(stats.total)} contributions in the last year`;
    const blob = await garden.toBlob(caption);
    const name = data.isDemo ? `demo-${data.seed}` : data.username;
    ui.downloadBlob(blob, `commit-garden-${name}.png`);
    ui.toast('Screenshot saved 📸');
  } catch (err) {
    console.error(err);
    ui.toast('Couldn’t create the screenshot, sorry.');
  } finally {
    ui.setBusy('downloadBtn', false);
  }
}

async function copyLink() {
  if (!current) return;
  const url = shareUrl(current.data);
  const ok = await ui.copyText(url);
  ui.toast(ok ? 'Link copied to clipboard 🔗' : `Copy this link: ${url}`);
}

function toggleTheme() {
  const night = !garden.isNight;
  garden.setNight(night);
  ui.setNight(night);
  saveFlag(THEME_KEY, night);
}

function setMotionPaused(paused, { save = true } = {}) {
  garden.setMotionPaused(paused);
  ui.setMotionPaused(paused);
  if (save) saveFlag(MOTION_KEY, paused);
}

// ---- capture mode ----------------------------------------------------------
// ?user=<name>&capture=1 renders one still, deterministic garden with a caption,
// then sets window.__GARDEN_READY__ (or __GARDEN_ERROR__) for screenshot tools.

async function loadCaptureData(params) {
  const user = normalizeUsername(params.get('user'));
  const demo = params.get('demo');
  if (!user && demo !== null) return generateDemoData(Number.parseInt(demo, 10) || 0);
  if (!user) throw new GardenError('Capture mode needs a ?user=<name> parameter.', 'invalid');
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchContributions(user);
    } catch (err) {
      const retryable = ['network', 'timeout', 'rate-limit', 'server'].includes(err?.kind);
      if (!retryable || attempt >= CAPTURE_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function startCapture(params) {
  ui.enterCaptureMode();
  ui.setNight(false);
  garden.enableCaptureMode();
  try {
    const data = await loadCaptureData(params);
    const { total } = computeStats(data.days);
    const rank = getRank(total);
    const who = data.isDemo ? 'Demo garden' : data.username;
    const contributions = `${formatNumber(total)} ${total === 1 ? 'contribution' : 'contributions'}`;
    ui.showCaptureOverlay(`🌱 ${who} · ${contributions} · ${rank.emoji} ${rank.name}`);
    garden.setInsets(ui.getCaptureInsets());
    garden.setGarden(data);
    updateTitle(data);
    await document.fonts?.ready;
    // One frame renders the scene (and its shadow map), the next one confirms it's on screen.
    await garden.nextFrame();
    await garden.nextFrame();
    window.__GARDEN_READY__ = true;
  } catch (err) {
    const message = err?.message || String(err);
    if (!(err instanceof GardenError)) console.error(err);
    ui.showCaptureOverlay(`⚠️ ${message}`);
    window.__GARDEN_ERROR__ = message;
  }
}

// ---- boot ----------------------------------------------------------------

function init() {
  const params = new URLSearchParams(window.location.search);
  const capture = params.get('capture') === '1';

  try {
    garden = new Garden(document.getElementById('scene'));
  } catch (err) {
    console.error(err);
    ui.showFatal('Your browser can’t display 3D graphics (WebGL is unavailable), so the garden can’t grow here. Try another browser or device.');
    if (capture) window.__GARDEN_ERROR__ = 'WebGL is unavailable';
    return;
  }

  if (capture) {
    startCapture(params);
    return;
  }

  // With no saved choice, start in the same mode as the operating system.
  const night = readFlag(THEME_KEY) ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
  garden.setNight(night, { instant: true });
  ui.setNight(night);
  setMotionPaused(readFlag(MOTION_KEY) ?? false, { save: false });

  // A bare island slowly turns behind the landing screen.
  garden.setGarden(generateEmptyGarden(), { animate: false, intro: false });

  garden.onTooltip = (info) => ui.showTooltip(info);
  garden.onContextLost = () =>
    ui.toast('The 3D view was interrupted by your graphics driver. It should come back by itself; reload if it doesn’t.');

  ui.on('submit', (value) => loadUser(value));
  ui.on('demo', () => loadDemo());
  ui.on('back', backToGarden);
  ui.on('newGarden', () => {
    cancelPendingLoad();
    showLanding();
  });
  ui.on('toggleTheme', toggleTheme);
  ui.on('toggleMotion', () => setMotionPaused(!garden.motionPaused));
  ui.on('replay', () => {
    if (!current) return;
    garden.replay();
    ui.animateStats(current.stats, GROW_DURATION);
  });
  ui.on('download', downloadPng);
  ui.on('copyLink', copyLink);

  // Handy for poking at the scene from devtools during development (stripped from builds).
  if (import.meta.env.DEV) window.__garden = garden;

  window.addEventListener('popstate', route);
  window.addEventListener('resize', () => {
    if (!ui.isLandingVisible()) garden.setInsets(ui.getSafeInsets());
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ui.isLandingVisible() && current) backToGarden();
    else garden.clearSelection();
  });

  route();
}

init();
