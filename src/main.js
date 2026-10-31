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
const CAPTURE_ATTEMPTS = 3;

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

function readSavedNight() {
  try {
    return window.localStorage.getItem(THEME_KEY) === '1';
  } catch {
    return false;
  }
}

function saveNight(isNight) {
  try {
    window.localStorage.setItem(THEME_KEY, isNight ? '1' : '0');
  } catch {
    // Storage can be unavailable (private mode); the toggle still works for this visit.
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

function backToGarden() {
  if (!current) return;
  cancelPendingLoad();
  ui.hideLanding();
  garden.setInsets(ui.getSafeInsets());
  garden.setInteractive(true);
  updateTitle(current.data);
}

function updateTitle(data) {
  document.title = data.isDemo ? 'Demo garden · Commit Garden' : `${data.username} · Commit Garden`;
}

function showGarden(data) {
  const stats = computeStats(data.days);
  current = { data, stats };
  ui.showGarden({ data, stats, rank: getRank(stats.total), growDuration: GROW_DURATION });
  garden.setInsets(ui.getSafeInsets());
  garden.setInteractive(true);
  garden.setGarden(data);
  updateTitle(data);
}

// ---- loading -------------------------------------------------------------

async function loadUser(input, { push = true } = {}) {
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
    const data = cache.get(key) ?? (await fetchContributions(username, { signal: controller.signal }));
    if (token !== loadToken) return;
    cache.set(key, data);
    showGarden(data);
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

function loadDemo(seed, { push = true } = {}) {
  cancelPendingLoad();
  const data = Number.isFinite(seed) && seed >= 0 ? generateDemoData(seed) : generateDemoData();
  showGarden(data);
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
      backToGarden();
      return;
    }
    showLanding();
    loadUser(user, { push: false });
  } else if (demo !== null) {
    loadDemo(Number.parseInt(demo, 10), { push: false });
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
  saveNight(night);
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
      const retryable = ['network', 'timeout', 'server'].includes(err?.kind);
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

  const night = readSavedNight();
  garden.setNight(night, { instant: true });
  ui.setNight(night);

  // A bare island slowly turns behind the landing screen.
  garden.setGarden(generateEmptyGarden(), { animate: false, intro: false });

  garden.onTooltip = (info) => ui.showTooltip(info);

  ui.on('submit', (value) => loadUser(value));
  ui.on('demo', () => loadDemo());
  ui.on('back', backToGarden);
  ui.on('newGarden', () => {
    cancelPendingLoad();
    showLanding();
  });
  ui.on('toggleTheme', toggleTheme);
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
