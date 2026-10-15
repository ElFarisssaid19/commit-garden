// Contribution data: fetching, demo generation, grid layout and stats.

const API_BASE = 'https://github-contributions-api.jogruber.de/v4/';
const REQUEST_TIMEOUT_MS = 15000;
const DAY_MS = 86400000;

/** GitHub's graph shows at most 53 week columns. */
export const MAX_WEEKS = 53;

// GitHub usernames: 1–39 chars, alphanumeric or single hyphens, no leading/trailing hyphen.
const USERNAME_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export class GardenError extends Error {
  /**
   * @param {string} message Friendly, user-facing message.
   * @param {'invalid'|'not-found'|'network'|'timeout'|'server'|'data'|'aborted'} kind
   */
  constructor(message, kind) {
    super(message);
    this.name = 'GardenError';
    this.kind = kind;
  }
}

/** Accepts "octocat", "@octocat" or a pasted profile URL and returns the bare username. */
export function normalizeUsername(input) {
  return String(input ?? '')
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/^@/, '')
    .split(/[/?#\s]/)[0];
}

export function isValidUsername(name) {
  return USERNAME_RE.test(name);
}

/**
 * Fetches the last year of contributions for a GitHub user.
 * @returns {Promise<GardenData>}
 */
export async function fetchContributions(username, { signal } = {}) {
  if (!isValidUsername(username)) {
    throw new GardenError(
      'That doesn’t look like a GitHub username. Use letters, numbers and single hyphens (up to 39 characters).',
      'invalid',
    );
  }

  // Combine the caller's abort signal with a request timeout.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let response;
  try {
    response = await fetch(`${API_BASE}${encodeURIComponent(username)}?y=last`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (timedOut) {
      throw new GardenError('The contributions API took too long to answer. Please try again in a moment.', 'timeout');
    }
    if (err?.name === 'AbortError') throw new GardenError('Request cancelled.', 'aborted');
    throw new GardenError(
      'Couldn’t reach the contributions API. Check your connection — or try the demo garden, it works offline.',
      'network',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (response.status === 404) {
    throw new GardenError(`We couldn’t find a GitHub user called “${username}”. Check the spelling and try again.`, 'not-found');
  }
  if (!response.ok) {
    throw new GardenError(
      `The contributions API returned an error (HTTP ${response.status}). Please try again in a moment.`,
      'server',
    );
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new GardenError('The contributions API sent back something unexpected. Please try again.', 'data');
  }
  if (!json || !Array.isArray(json.contributions) || json.contributions.length === 0) {
    throw new GardenError('The contributions API sent back something unexpected. Please try again.', 'data');
  }

  return layoutGarden(json.contributions, { username, isDemo: false });
}

/**
 * @typedef {{ date: string, count: number, level: number, week: number, weekday: number, index: number }} Day
 * @typedef {{ username: string|null, isDemo: boolean, seed: number, days: Day[], weeks: number }} GardenData
 */

/** Sorts raw days and assigns each one a (week, weekday) cell like GitHub's graph. */
export function layoutGarden(rawDays, { username = null, isDemo = false, seed } = {}) {
  const parsed = rawDays
    .filter((d) => d && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .map((d) => ({
      date: d.date,
      time: Date.parse(`${d.date}T00:00:00Z`),
      count: Math.max(0, Math.floor(Number(d.count) || 0)),
      level: Math.min(4, Math.max(0, Math.floor(Number(d.level) || 0))),
    }))
    .filter((d) => Number.isFinite(d.time))
    .sort((a, b) => a.time - b.time);

  if (parsed.length === 0) {
    throw new GardenError('No contribution data was found for this user.', 'data');
  }

  const firstTime = parsed[0].time;
  const firstWeekday = new Date(firstTime).getUTCDay();
  for (const d of parsed) {
    const dayNumber = Math.round((d.time - firstTime) / DAY_MS);
    d.week = Math.floor((dayNumber + firstWeekday) / 7);
    d.weekday = new Date(d.time).getUTCDay();
  }

  // Keep the most recent 53 weeks so the grid matches GitHub's layout.
  const lastWeek = parsed[parsed.length - 1].week;
  const minWeek = Math.max(0, lastWeek - (MAX_WEEKS - 1));
  const days = parsed
    .filter((d) => d.week >= minWeek)
    .map((d, index) => ({
      date: d.date,
      count: d.count,
      level: d.level,
      week: d.week - minWeek,
      weekday: d.weekday,
      index,
    }));

  return {
    username,
    isDemo,
    seed: seed ?? hashString((username ?? 'garden').toLowerCase()),
    days,
    weeks: lastWeek - minWeek + 1,
  };
}

/** Random-but-plausible contribution data for the demo garden (no network needed). */
export function generateDemoData(seed = Math.floor(Math.random() * 2 ** 31)) {
  const rand = createRandom(seed);
  const now = new Date();
  const end = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const yearAgo = end - 365 * DAY_MS;
  const start = yearAgo - new Date(yearAgo).getUTCDay() * DAY_MS;

  // Weekly "energy" follows a smoothed random walk with the odd vacation.
  let energy = 0.35 + rand() * 0.4;
  let weekEnergy = energy;
  const raw = [];
  for (let t = start, i = 0; t <= end; t += DAY_MS, i++) {
    const weekday = new Date(t).getUTCDay();
    if (weekday === 0) {
      energy = Math.min(1, Math.max(0.05, energy + (rand() - 0.5) * 0.35));
      weekEnergy = rand() < 0.06 ? 0 : energy;
    }
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const chance = weekEnergy * weekendFactor;
    let count = 0;
    if (rand() < chance * 1.15) {
      count = 1 + Math.floor(rand() ** 2 * 14 * (0.4 + weekEnergy));
      if (rand() < 0.04) count += 12 + Math.floor(rand() * 30); // release day!
    }
    raw.push({ date: new Date(t).toISOString().slice(0, 10), count });
  }

  // Levels from quartiles of the non-zero counts, the way GitHub buckets them.
  const nonZero = raw.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => nonZero[Math.min(nonZero.length - 1, Math.floor(p * nonZero.length))] ?? 1;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  for (const d of raw) {
    d.level = d.count === 0 ? 0 : d.count <= q1 ? 1 : d.count <= q2 ? 2 : d.count <= q3 ? 3 : 4;
  }

  return layoutGarden(raw, { username: null, isDemo: true, seed });
}

/** Empty garden (all bare dirt) shown behind the landing screen. */
export function generateEmptyGarden() {
  const now = new Date();
  const end = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const yearAgo = end - 365 * DAY_MS;
  const start = yearAgo - new Date(yearAgo).getUTCDay() * DAY_MS;
  const raw = [];
  for (let t = start; t <= end; t += DAY_MS) {
    raw.push({ date: new Date(t).toISOString().slice(0, 10), count: 0, level: 0 });
  }
  return layoutGarden(raw, { username: null, isDemo: true, seed: 7 });
}

export function computeStats(days) {
  let total = 0;
  let longest = 0;
  let run = 0;
  let best = null;
  let activeDays = 0;

  for (const d of days) {
    total += d.count;
    if (d.count > 0) {
      activeDays++;
      run++;
      longest = Math.max(longest, run);
      if (!best || d.count > best.count) best = d;
    } else {
      run = 0;
    }
  }

  // Current streak counts back from today; a quiet "today" doesn't break it yet.
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  for (; i >= 0 && days[i].count > 0; i--) current++;

  return {
    total,
    longest,
    current,
    activeDays,
    bestDay: best ? { date: best.date, count: best.count } : null,
  };
}

export const RANKS = [
  { name: 'Desert', emoji: '🏜️', min: 0, blurb: 'A few hardy seeds are waiting for rain.' },
  { name: 'Oasis', emoji: '🌴', min: 100, blurb: 'Life is gathering around the water.' },
  { name: 'Meadow', emoji: '🌼', min: 400, blurb: 'Wildflowers as far as the eye can see.' },
  { name: 'Forest', emoji: '🌲', min: 1000, blurb: 'Tall trees, deep shade and birdsong.' },
  { name: 'Jungle', emoji: '🦜', min: 2500, blurb: 'A roaring, overgrown paradise.' },
];

export function getRank(total) {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) if (total >= RANKS[i].min) index = i;
  const rank = RANKS[index];
  const next = RANKS[index + 1] ?? null;
  return {
    ...rank,
    index,
    next,
    toNext: next ? next.min - total : 0,
    progress: next ? (total - rank.min) / (next.min - rank.min) : 1,
  };
}

/** Small, fast seeded PRNG (mulberry32) so a user's garden always looks the same. */
export function createRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
