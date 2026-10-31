// DOM side of the app: landing screen, HUD, stats panel, tooltip and toasts.

const $ = (id) => document.getElementById(id);

/** Must match the compact-layout media query in style.css. */
const COMPACT_QUERY = '(max-width: 759px), (max-height: 560px)';

const numberFormat = new Intl.NumberFormat();
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const formatNumber = (n) => numberFormat.format(n);
const toUtcDate = (iso) => new Date(`${iso}T00:00:00Z`);
const plural = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** How long a fetch runs before the landing screen says the API is just slow. */
const SLOW_HINT_MS = 4000;

function contributionsLabel(count) {
  return count === 0 ? 'No contributions' : plural(count, 'contribution', 'contributions');
}

export function createUI() {
  const el = {
    landing: $('landing'),
    form: $('grow-form'),
    input: $('username'),
    growBtn: $('grow-btn'),
    demoBtn: $('demo-btn'),
    backBtn: $('back-btn'),
    error: $('error'),
    slowHint: $('slow-hint'),
    topbar: $('topbar'),
    brandBtn: $('brand-btn'),
    userChip: $('user-chip'),
    userAvatar: $('user-avatar'),
    userName: $('user-name'),
    stats: $('stats'),
    statsToggle: $('stats-toggle'),
    rankEmoji: $('rank-emoji'),
    rankName: $('rank-name'),
    rankBlurb: $('rank-blurb'),
    rankBar: $('rank-bar-fill'),
    rankNext: $('rank-next'),
    total: $('stat-total'),
    totalMini: $('stat-total-mini'),
    longest: $('stat-longest'),
    current: $('stat-current'),
    best: $('stat-best'),
    toolbar: $('toolbar'),
    themeBtn: $('btn-theme'),
    themeIcon: $('theme-icon'),
    themeLabel: $('theme-label'),
    motionBtn: $('btn-motion'),
    motionIcon: $('motion-icon'),
    replayBtn: $('btn-replay'),
    downloadBtn: $('btn-download'),
    copyBtn: $('btn-copy'),
    newBtn: $('btn-new'),
    tooltip: $('tooltip'),
    tooltipCount: $('tooltip-count'),
    tooltipDate: $('tooltip-date'),
    dayAnnouncer: $('day-announcer'),
    toast: $('toast'),
    captureOverlay: $('capture-overlay'),
  };

  const hud = [el.topbar, el.stats, el.toolbar];
  const compactQuery = window.matchMedia(COMPACT_QUERY);
  const finePointer = window.matchMedia('(pointer: fine)');
  const counters = new Map();
  let toastTimer = 0;
  let slowTimer = 0;
  let tooltipDay = null;

  /** Callbacks wired up by main.js. */
  const handlers = {
    submit: () => {},
    demo: () => {},
    back: () => {},
    newGarden: () => {},
    toggleTheme: () => {},
    toggleMotion: () => {},
    replay: () => {},
    download: () => {},
    copyLink: () => {},
  };

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    handlers.submit(el.input.value);
  });
  el.input.addEventListener('input', () => hideError());
  el.demoBtn.addEventListener('click', () => handlers.demo());
  el.backBtn.addEventListener('click', () => handlers.back());
  el.brandBtn.addEventListener('click', () => handlers.newGarden());
  el.newBtn.addEventListener('click', () => handlers.newGarden());
  el.themeBtn.addEventListener('click', () => handlers.toggleTheme());
  el.motionBtn.addEventListener('click', () => handlers.toggleMotion());
  el.replayBtn.addEventListener('click', () => handlers.replay());
  el.downloadBtn.addEventListener('click', () => handlers.download());
  el.copyBtn.addEventListener('click', () => handlers.copyLink());
  el.statsToggle.addEventListener('click', () => {
    if (!compactQuery.matches) return;
    el.stats.classList.toggle('collapsed');
    syncStatsToggle();
  });

  /** The stats header only collapses on compact layouts; elsewhere the panel is always open. */
  function syncStatsToggle() {
    const compact = compactQuery.matches;
    el.statsToggle.setAttribute('aria-expanded', String(!compact || !el.stats.classList.contains('collapsed')));
    if (compact) el.statsToggle.removeAttribute('aria-disabled');
    else el.statsToggle.setAttribute('aria-disabled', 'true');
  }
  compactQuery.addEventListener('change', syncStatsToggle);
  syncStatsToggle();

  function on(name, fn) {
    handlers[name] = fn;
  }

  // ---- landing -------------------------------------------------------------

  function isLandingVisible() {
    return !el.landing.classList.contains('is-hidden');
  }

  function showLanding({ canGoBack = false, focus = true } = {}) {
    el.landing.classList.remove('is-hidden');
    el.landing.removeAttribute('aria-hidden');
    el.landing.inert = false;
    el.backBtn.hidden = !canGoBack;
    for (const node of hud) node.hidden = true;
    hideTooltip();
    if (focus && finePointer.matches) {
      el.input.focus();
      el.input.select();
    }
  }

  function hideLanding() {
    el.landing.classList.add('is-hidden');
    el.landing.setAttribute('aria-hidden', 'true');
    el.landing.inert = true;
    hideError();
    for (const node of hud) node.hidden = false;
  }

  function setLoading(loading) {
    el.growBtn.classList.toggle('is-loading', loading);
    el.growBtn.disabled = loading;
    el.demoBtn.disabled = loading;
    el.input.readOnly = loading;
    el.growBtn.setAttribute('aria-busy', String(loading));
    // The API sometimes takes several seconds; say so instead of leaving a lone spinner.
    // The hint is a live region, so it's announced when its text appears.
    clearTimeout(slowTimer);
    el.slowHint.textContent = '';
    if (loading) slowTimer = setTimeout(() => (el.slowHint.textContent = 'Still fetching… the API can be slow.'), SLOW_HINT_MS);
  }

  function setInputValue(value) {
    el.input.value = value;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
    // Restart the shake animation.
    el.error.classList.remove('shake');
    void el.error.offsetWidth;
    el.error.classList.add('shake');
  }

  function hideError() {
    el.error.hidden = true;
  }

  // ---- garden HUD ------------------------------------------------------------

  function showGarden({ data, stats, rank, growDuration }) {
    hideLanding();

    if (data.isDemo) {
      el.userChip.removeAttribute('href');
      el.userChip.removeAttribute('title');
      el.userChip.classList.add('is-demo');
      el.userAvatar.hidden = true;
      el.userName.textContent = '✨ Demo garden';
    } else {
      el.userChip.href = `https://github.com/${encodeURIComponent(data.username)}`;
      el.userChip.title = `Open ${data.username} on GitHub`;
      el.userChip.classList.remove('is-demo');
      el.userAvatar.hidden = false;
      el.userAvatar.src = `https://github.com/${encodeURIComponent(data.username)}.png?size=64`;
      el.userName.textContent = `@${data.username}`;
    }

    el.rankEmoji.textContent = rank.emoji;
    el.rankName.textContent = rank.name;
    el.rankBlurb.textContent = rank.blurb;
    el.rankNext.textContent = rank.next
      ? `${formatNumber(rank.toNext)} more to ${rank.next.emoji} ${rank.next.name}`
      : 'Top rank — it’s a jungle out there!';
    el.rankBar.style.width = '0%';
    requestAnimationFrame(() => {
      el.rankBar.style.width = `${Math.round(rank.progress * 100)}%`;
    });

    animateStats(stats, growDuration);
  }

  function animateStats(stats, duration = 0) {
    countUp(el.total, stats.total, duration, formatNumber);
    countUp(el.totalMini, stats.total, duration, formatNumber);
    countUp(el.longest, stats.longest, duration, (n) => plural(n, 'day', 'days'));
    countUp(el.current, stats.current, duration, (n) => plural(n, 'day', 'days'));
    if (stats.bestDay) {
      el.best.innerHTML = '';
      const strong = document.createElement('span');
      const small = document.createElement('small');
      small.textContent = ` on ${shortDate.format(toUtcDate(stats.bestDay.date))}`;
      el.best.append(strong, small);
      countUp(strong, stats.bestDay.count, duration, formatNumber);
    } else {
      el.best.textContent = '—';
    }
  }

  function countUp(node, to, seconds, format) {
    cancelAnimationFrame(counters.get(node));
    if (!seconds || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.textContent = format(to);
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / (seconds * 1000));
      const eased = 1 - (1 - p) ** 3;
      node.textContent = format(Math.round(to * eased));
      if (p < 1) counters.set(node, requestAnimationFrame(tick));
    };
    counters.set(node, requestAnimationFrame(tick));
  }

  function setNight(isNight) {
    document.body.classList.toggle('is-night', isNight);
    el.themeBtn.setAttribute('aria-pressed', String(isNight));
    el.themeIcon.textContent = isNight ? '☀️' : '🌙';
    el.themeLabel.textContent = isNight ? 'Day' : 'Night';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isNight ? '#262e69' : '#f5dfc3');
  }

  /** The label stays "Pause" (it names the action); aria-pressed and the icon show the state. */
  function setMotionPaused(paused) {
    el.motionBtn.setAttribute('aria-pressed', String(paused));
    el.motionIcon.textContent = paused ? '▶️' : '⏸️'; // emoji presentation, like the other toolbar icons
    el.motionBtn.title = paused ? 'Resume the garden’s motion' : 'Pause the garden’s motion';
  }

  /** Screen margins covered by the HUD so the 3D view can frame the garden around them. */
  function getSafeInsets() {
    if (isLandingVisible()) return { top: 0, right: 0, bottom: 0, left: 0 };
    const top = el.topbar.getBoundingClientRect().bottom;
    const toolbarTop = el.toolbar.getBoundingClientRect().top;
    const statsRect = el.stats.getBoundingClientRect();
    // On phones, size for the collapsed sheet so expanding it doesn't reframe the scene.
    const statsTop =
      compactQuery.matches && !el.stats.classList.contains('collapsed')
        ? statsRect.bottom - el.statsToggle.getBoundingClientRect().height
        : statsRect.top;
    return { top, right: 0, bottom: window.innerHeight - Math.min(toolbarTop, statsTop), left: 0 };
  }

  // ---- tooltip & toast -------------------------------------------------------

  function showTooltip(info) {
    if (!info) {
      hideTooltip();
      return;
    }
    const tip = el.tooltip;
    if (tooltipDay !== info.day) {
      tooltipDay = info.day;
      el.tooltipCount.textContent = contributionsLabel(info.day.count);
      el.tooltipDate.textContent = longDate.format(toUtcDate(info.day.date));
      // Screen readers hear days picked with the keyboard or a tap, not every mouse hover.
      if (info.mode !== 'hover') el.dayAnnouncer.textContent = `${el.tooltipCount.textContent}, ${el.tooltipDate.textContent}`;
    }
    tip.hidden = false;
    tip.classList.toggle('is-anchored', info.mode !== 'hover');
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left;
    let top;
    if (info.mode === 'hover') {
      left = info.x + 16;
      top = info.y + 18;
      if (left + w > vw - 8) left = info.x - w - 12;
      if (top + h > vh - 8) top = info.y - h - 12;
    } else {
      left = info.x - w / 2;
      top = info.y - h - 12;
    }
    left = Math.min(Math.max(8, left), vw - w - 8);
    top = Math.min(Math.max(8, top), vh - h - 8);
    tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function hideTooltip() {
    el.tooltip.hidden = true;
    tooltipDay = null;
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  // ---- browser helpers ----------------------------------------------------------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for non-secure contexts (e.g. testing over a LAN IP).
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function setBusy(button, busy) {
    const node = el[button];
    node.disabled = busy;
    node.setAttribute('aria-busy', String(busy));
  }

  // ---- capture mode ------------------------------------------------------------

  function enterCaptureMode() {
    document.body.classList.add('capture-mode');
    el.landing.classList.add('is-hidden');
    el.landing.inert = true;
    for (const node of hud) node.hidden = true;
    hideTooltip();
  }

  function showCaptureOverlay(text) {
    el.captureOverlay.textContent = text;
    el.captureOverlay.hidden = false;
  }

  /** Bottom margin so the island is framed clear of the caption. */
  function getCaptureInsets() {
    const bottom = el.captureOverlay.hidden ? 0 : window.innerHeight - el.captureOverlay.getBoundingClientRect().top;
    return { top: 0, right: 0, bottom, left: 0 };
  }

  function showFatal(message) {
    showLanding({ focus: false });
    el.form.hidden = true;
    el.demoBtn.hidden = true;
    showError(message);
  }

  return {
    on,
    isLandingVisible,
    showLanding,
    hideLanding,
    setLoading,
    setInputValue,
    showError,
    hideError,
    showGarden,
    animateStats,
    setNight,
    setMotionPaused,
    getSafeInsets,
    showTooltip,
    hideTooltip,
    toast,
    copyText,
    downloadBlob,
    setBusy,
    showFatal,
    enterCaptureMode,
    showCaptureOverlay,
    getCaptureInsets,
  };
}
