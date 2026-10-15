// The 3D garden: scene, lighting, camera, procedural low-poly plants and animation.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom, MAX_WEEKS } from './data.js';

const TAU = Math.PI * 2;

// Layout (world units; one tile = one day)
const SPACING = 1;
const TILE_HEIGHT = 0.22;
const ISLAND_MARGIN = 1.1;
const SOIL_DEPTH = 0.62;
const UNDERSIDE_DEPTH = 3.4;
const PLANT_TOP = 1.75;

// Timing (seconds)
const GROW_SPREAD = 3.4; // every day starts growing within this window...
const POP_DURATION = 0.6; // ...and pops up over this long → ~4 s for the year
const HOP_DURATION = 0.42;
const THEME_DURATION = 1.4;
const INTRO_DURATION = 2.4;
const IDLE_BEFORE_ROTATE = 3.5;

// Camera
const FOV = 30;
const POLAR = THREE.MathUtils.degToRad(57);
const AZIMUTH_MIN = THREE.MathUtils.degToRad(20);
const AZIMUTH_MAX = THREE.MathUtils.degToRad(68);
const VIEW_PADDING = 18; // px kept clear around the garden when framing

const DIRT = ['#8b5d3b', '#7f5434', '#94643f', '#86593a', '#9a6a44'];
const GRASS_TILES = [null, '#9cbf5b', '#84b04e', '#6d9e45', '#5a8f3e'];
const FLOWER_COLORS = ['#ff5d6c', '#ff9248', '#ffd23f', '#ff8fd1', '#b388ff', '#ffffff', '#5ec8ff', '#ff6fa8'];
const BUSH_GREENS = ['#5a9e44', '#4f9140', '#6aae4b', '#79b552', '#478a46'];
const PINE_GREENS = ['#3d8048', '#2f7343', '#4b8c4a', '#3a7a55'];
const BLOSSOM_PINKS = ['#f7a8c4', '#f4b5d6', '#fbc4d4', '#f29bb8', '#e7b3ee'];
const FRUIT_COLORS = ['#e63946', '#ff8a3d', '#ffc93c', '#d93f6e'];
const PEBBLE_COLORS = ['#b8ab98', '#a39886', '#c9bda8', '#8f8577'];
const FIREFLY_COLOR = new THREE.Color('#e2ff8a');

const THEMES = {
  day: {
    bgTop: '#86c6ee',
    bgBottom: '#fde6cb',
    glow: '#fff4dc',
    glowStrength: 0.35,
    fog: '#f3dcc4',
    hemiSky: '#fff2da',
    hemiGround: '#9c8262',
    hemiIntensity: 1.5,
    light: '#ffe6c0',
    lightIntensity: 2.7,
    lightDir: [0.55, 1, 0.45],
    shadowIntensity: 0.85,
    exposure: 1,
  },
  night: {
    bgTop: '#050920',
    bgBottom: '#262e69',
    glow: '#4b56a8',
    glowStrength: 0.3,
    fog: '#1c2352',
    hemiSky: '#8a9be2',
    hemiGround: '#2f2a4d',
    hemiIntensity: 0.85,
    light: '#c0cdff',
    lightIntensity: 1.35,
    lightDir: [-0.45, 1, 0.35],
    shadowIntensity: 0.65,
    exposure: 1.05,
  },
};

const ONE = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _axis = new THREE.Vector3();
const _euler = new THREE.Euler();

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const range = (rand, min, max) => min + rand() * (max - min);

// ---------------------------------------------------------------------------
// Procedural geometry helpers. Every part is converted to non-indexed geometry
// with position/normal/color attributes so parts can be merged per plant type.

function matrix(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Tilts "up" toward the horizontal direction `angle` by `tilt` radians. */
function tiltQuaternion(angle, tilt) {
  return new THREE.Quaternion().setFromAxisAngle(_axis.set(Math.sin(angle), 0, -Math.cos(angle)), tilt);
}

function paint(geometry, color) {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function finalize(geometry, color, transform) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  if (g.hasAttribute('uv')) g.deleteAttribute('uv');
  if (transform) g.applyMatrix4(transform);
  return paint(g, color);
}

/** Moves vertices by a random offset keyed on position so shared corners stay welded. */
function jitter(geometry, amount, rand, filter = null) {
  const pos = geometry.attributes.position;
  const offsets = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (filter && !filter(x, y, z)) continue;
    const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let o = offsets.get(key);
    if (!o) {
      const a = Array.isArray(amount) ? amount : [amount, amount, amount];
      o = [(rand() - 0.5) * 2 * a[0], (rand() - 0.5) * 2 * a[1], (rand() - 0.5) * 2 * a[2]];
      offsets.set(key, o);
    }
    pos.setXYZ(i, x + o[0], y + o[1], z + o[2]);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function blob(rand, radius, detail = 0, roughness = 0.2) {
  return jitter(new THREE.IcosahedronGeometry(radius, detail), radius * roughness, rand);
}

function mergeParts(parts) {
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('Could not merge plant geometry');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

function randomDirection(rand, minY = -1, maxY = 1) {
  const y = range(rand, minY, maxY);
  const r = Math.sqrt(1 - y * y);
  const a = rand() * TAU;
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
}

// ---------------------------------------------------------------------------
// Plants. Each builder returns { base, tint }: `base` keeps its vertex colors
// (with a subtle per-instance brightness), `tint` is white and takes a random
// per-instance color from the type's palette.

function buildSprouts(rand) {
  const parts = [];
  const greens = ['#7fc04b', '#68ab3f', '#93cf5c'];
  const blades = 6 + Math.floor(rand() * 3);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU + rand() * 0.5;
    const r = 0.03 + rand() * 0.11;
    const h = 0.24 + rand() * 0.22;
    const g = new THREE.ConeGeometry(0.05, h, 3);
    g.translate(0, h / 2, 0);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
      tiltQuaternion(a, 0.15 + rand() * 0.4),
      ONE,
    );
    parts.push(finalize(g, greens[i % greens.length], m));
  }
  return { base: mergeParts(parts), tint: null };
}

function buildFlowers(rand) {
  const base = [];
  const tint = [];
  const count = 2 + Math.floor(rand() * 2);
  for (let f = 0; f < count; f++) {
    const a = (f / count) * TAU + rand() * 0.8;
    const r = 0.1 + rand() * 0.08;
    const h = 0.32 + rand() * 0.24;
    const stemM = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
      tiltQuaternion(a, rand() * 0.25),
      ONE,
    );
    const stem = new THREE.CylinderGeometry(0.018, 0.026, h, 4);
    stem.translate(0, h / 2, 0);
    base.push(finalize(stem, '#4f9a3c', stemM));

    const leafM = stemM.clone().multiply(matrix(0, h * 0.3, 0, 0, rand() * TAU, 0)).multiply(matrix(0.06, 0, 0, 0, 0, 0.5, 1.6, 0.32, 0.7));
    base.push(finalize(new THREE.IcosahedronGeometry(0.06, 0), '#5aa645', leafM));

    const headM = stemM.clone().multiply(matrix(0, h, 0, (rand() - 0.5) * 0.4, 0, (rand() - 0.5) * 0.4));
    base.push(finalize(new THREE.IcosahedronGeometry(0.045, 0), '#ffcd38', headM.clone().multiply(matrix(0, 0.015, 0))));
    const petals = 5 + Math.floor(rand() * 2);
    for (let p = 0; p < petals; p++) {
      const pm = headM
        .clone()
        .multiply(matrix(0, 0, 0, 0, (p / petals) * TAU, 0))
        .multiply(matrix(0.075, 0, 0, 0, 0, 0.28, 1.45, 0.42, 0.9));
      tint.push(finalize(new THREE.IcosahedronGeometry(0.055, 0), '#ffffff', pm));
    }
  }
  return { base: mergeParts(base), tint: mergeParts(tint) };
}

function buildBush(rand, withBerries) {
  const tint = [];
  const base = [];
  const shades = ['#ffffff', '#dedede'];
  const blobs = [{ c: new THREE.Vector3(0, 0.25, 0), r: 0.3 }];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + rand() * 0.6;
    blobs.push({ c: new THREE.Vector3(Math.cos(a) * 0.2, 0.17, Math.sin(a) * 0.2), r: 0.2 + rand() * 0.05 });
  }
  blobs.push({ c: new THREE.Vector3((rand() - 0.5) * 0.12, 0.43, (rand() - 0.5) * 0.12), r: 0.18 });
  blobs.forEach((b, i) => {
    tint.push(finalize(blob(rand, b.r, 0, 0.22), shades[i % 2], matrix(b.c.x, b.c.y, b.c.z)));
  });
  if (withBerries) {
    for (let i = 0; i < 6; i++) {
      const b = blobs[i % blobs.length];
      const p = randomDirection(rand, 0, 0.9).multiplyScalar(b.r * 0.95).add(b.c);
      base.push(finalize(new THREE.IcosahedronGeometry(0.042, 0), i % 2 ? '#e8344a' : '#c41f3c', matrix(p.x, p.y, p.z)));
    }
  }
  return { base: mergeParts(base), tint: mergeParts(tint) };
}

function buildPine(rand) {
  const trunk = new THREE.CylinderGeometry(0.045, 0.07, 0.34, 5);
  trunk.translate(0, 0.17, 0);
  const base = [finalize(trunk, '#7a4b2a')];
  const tiers = [
    [0.36, 0.44, 0.22],
    [0.28, 0.38, 0.45],
    [0.2, 0.32, 0.66],
  ];
  const shades = ['#ffffff', '#e6e6e6', '#f4f4f4'];
  const tint = tiers.map(([r, h, y], i) => {
    const cone = new THREE.ConeGeometry(r, h, 7);
    cone.translate(0, h / 2, 0);
    const g = finalize(cone, shades[i]);
    jitter(g, [0.03, 0.02, 0.03], rand);
    g.applyMatrix4(matrix(0, y, 0, 0, rand() * TAU, 0));
    return g;
  });
  return { base: mergeParts(base), tint: mergeParts(tint) };
}

function buildTrunk(rand, color) {
  const parts = [];
  const h = 0.9;
  const trunk = new THREE.CylinderGeometry(0.065, 0.115, h, 6, 2);
  trunk.translate(0, h / 2, 0);
  parts.push(jitter(finalize(trunk, color), [0.015, 0, 0.015], rand, (x, y) => y > 0.01));
  for (let b = 0; b < 2; b++) {
    const a = rand() * TAU;
    const branch = new THREE.CylinderGeometry(0.025, 0.042, 0.4, 5);
    branch.translate(0, 0.2, 0);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.48 + b * 0.14, 0), tiltQuaternion(a, 0.75), ONE);
    parts.push(finalize(branch, color, m));
  }
  return parts;
}

function canopyBlobs(rand) {
  const blobs = [{ c: new THREE.Vector3(0, 1.18, 0), r: 0.5 }];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + rand() * 0.7;
    blobs.push({
      c: new THREE.Vector3(Math.cos(a) * 0.36, 1.0 + rand() * 0.14, Math.sin(a) * 0.36),
      r: 0.3 + rand() * 0.06,
    });
  }
  blobs.push({ c: new THREE.Vector3((rand() - 0.5) * 0.15, 1.5, (rand() - 0.5) * 0.15), r: 0.3 });
  return blobs;
}

function surfacePoint(rand, blobs, minY, maxY, inset) {
  const b = blobs[Math.floor(rand() * blobs.length)];
  return randomDirection(rand, minY, maxY).multiplyScalar(b.r * inset).add(b.c);
}

function buildBlossomTree(rand) {
  const base = buildTrunk(rand, '#6e4529');
  const blobs = canopyBlobs(rand);
  const tint = blobs.map((b, i) => finalize(blob(rand, b.r, 1, 0.12), i % 2 ? '#ececec' : '#ffffff', matrix(b.c.x, b.c.y, b.c.z)));
  const petals = ['#ffffff', '#ffe3ec', '#fff3c4'];
  for (let i = 0; i < 18; i++) {
    const p = surfacePoint(rand, blobs, -0.2, 1, 0.97);
    base.push(finalize(new THREE.IcosahedronGeometry(0.055, 0), petals[i % petals.length], matrix(p.x, p.y, p.z, rand(), rand(), rand())));
  }
  return { base: mergeParts(base), tint: mergeParts(tint) };
}

function buildFruitTree(rand) {
  const base = buildTrunk(rand, '#6b4428');
  const blobs = canopyBlobs(rand);
  const greens = ['#5c9f45', '#4f9140', '#68ab4c'];
  blobs.forEach((b, i) => base.push(finalize(blob(rand, b.r, 1, 0.12), greens[i % greens.length], matrix(b.c.x, b.c.y, b.c.z))));
  const tint = [];
  for (let i = 0; i < 10; i++) {
    const p = surfacePoint(rand, blobs, -0.7, 0.45, 0.93);
    tint.push(finalize(new THREE.IcosahedronGeometry(0.075, 1), '#ffffff', matrix(p.x, p.y, p.z)));
  }
  return { base: mergeParts(base), tint: mergeParts(tint) };
}

const PLANT_TYPES = [
  { key: 'sprouts', level: 1, variants: 2, build: buildSprouts, scale: [0.9, 1.3], tints: null },
  { key: 'flowers', level: 2, variants: 2, build: buildFlowers, scale: [0.95, 1.2], tints: FLOWER_COLORS },
  { key: 'bush', level: 3, variants: 2, build: (rand, v) => buildBush(rand, v === 1), scale: [0.9, 1.2], tints: BUSH_GREENS },
  { key: 'pine', level: 3, variants: 1, build: buildPine, scale: [0.85, 1.15], tints: PINE_GREENS },
  { key: 'blossom', level: 4, variants: 1, build: buildBlossomTree, scale: [0.9, 1.12], tints: BLOSSOM_PINKS, fireflies: true },
  { key: 'fruit', level: 4, variants: 1, build: buildFruitTree, scale: [0.9, 1.12], tints: FRUIT_COLORS, fireflies: true },
];

// ---------------------------------------------------------------------------
// Island, decor and sky pieces

function buildIsland(hx, hz, rand) {
  const moss = new THREE.BoxGeometry(hx * 2 + 0.1, 0.16, hz * 2 + 0.1);
  moss.translate(0, -0.08, 0);
  const soil = new THREE.BoxGeometry(hx * 2, SOIL_DEPTH, hz * 2);
  soil.translate(0, -0.16 - SOIL_DEPTH / 2 + 0.001, 0);

  // Rocky underside: a tapered cylinder remapped onto the island's rectangle.
  const top = -0.16 - SOIL_DEPTH;
  const rock = new THREE.CylinderGeometry(1, 1, UNDERSIDE_DEPTH, 48, 5);
  const pos = rock.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Clamp: a tiny negative t from float rounding would make t ** 1.35 NaN.
    const t = clamp01((UNDERSIDE_DEPTH / 2 - pos.getY(i)) / UNDERSIDE_DEPTH);
    const r = Math.hypot(x, z);
    const s = 1 - 0.9 * t ** 1.35;
    let nx = 0;
    let nz = 0;
    if (r > 1e-6) {
      const k = 1 / Math.max(Math.abs(x / r), Math.abs(z / r));
      nx = (x / r) * k * hx * s;
      nz = (z / r) * k * hz * s;
    }
    pos.setXYZ(i, nx, top - t * UNDERSIDE_DEPTH, nz);
  }
  const rockG = finalize(rock, '#ffffff');
  jitter(rockG, [0.4, 0.22, 0.4], rand, (x, y) => y < top - 0.05);

  // Per-face colors: soil near the top fading into grey rock.
  const colors = rockG.attributes.color;
  const p = rockG.attributes.position;
  const soilC = new THREE.Color('#6f4730');
  const rockA = new THREE.Color('#8d8073');
  const rockB = new THREE.Color('#5f554e');
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const t = clamp01((top - y) / UNDERSIDE_DEPTH);
    if (t < 0.12) _c.copy(soilC);
    else _c.lerpColors(rockA, rockB, t);
    _c.multiplyScalar(0.92 + rand() * 0.14);
    for (let k = 0; k < 3; k++) colors.setXYZ(i + k, _c.r, _c.g, _c.b);
  }

  return mergeParts([finalize(moss, '#7ea653'), finalize(soil, '#7a4e32'), rockG]);
}

function buildCloud(rand) {
  const parts = [];
  const puffs = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < puffs; i++) {
    const r = range(rand, 0.9, 1.6) * (i === Math.floor(puffs / 2) ? 1.3 : 1);
    const x = (i - (puffs - 1) / 2) * 1.25 + (rand() - 0.5) * 0.4;
    parts.push(finalize(blob(rand, r, 1, 0.12), '#ffffff', matrix(x, rand() * 0.4, (rand() - 0.5) * 0.9, 0, 0, 0, 1, 0.72, 1)));
  }
  return mergeParts(parts);
}

function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const BACKGROUND_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BACKGROUND_FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  uniform vec3 glowColor;
  uniform float glowStrength;
  varying vec2 vUv;
  void main() {
    vec3 color = mix(bottomColor, topColor, smoothstep(0.0, 1.0, vUv.y));
    float d = distance(vUv, vec2(0.5, 0.38));
    color += glowColor * glowStrength * (1.0 - smoothstep(0.0, 0.7, d));
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

function themeColors(theme) {
  return {
    ...theme,
    bgTop: new THREE.Color(theme.bgTop),
    bgBottom: new THREE.Color(theme.bgBottom),
    glow: new THREE.Color(theme.glow),
    fog: new THREE.Color(theme.fog),
    hemiSky: new THREE.Color(theme.hemiSky),
    hemiGround: new THREE.Color(theme.hemiGround),
    light: new THREE.Color(theme.light),
    lightDir: new THREE.Vector3(...theme.lightDir).normalize(),
  };
}

function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  root.traverse((obj) => {
    if (obj.geometry) geometries.add(obj.geometry);
    if (obj.material) [].concat(obj.material).forEach((m) => materials.add(m));
    if (obj.isInstancedMesh) obj.dispose();
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}

// ---------------------------------------------------------------------------

export const GROW_DURATION = GROW_SPREAD + POP_DURATION;

export class Garden {
  /**
   * @param {HTMLElement} container Element the canvas is appended to.
   */
  constructor(container) {
    this.container = container;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    /** Called with { day, x, y, mode } or null whenever the tooltip should change. */
    this.onTooltip = null;

    this.themes = { day: themeColors(THEMES.day), night: themeColors(THEMES.night) };
    this.night = 0; // 0 = day, 1 = night (animated)
    this.nightTarget = 0;

    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.size = { width: 1, height: 1 };
    this.interactive = false;
    this.userMovedCamera = false;
    this.lastInteraction = -Infinity;
    this.dragging = false;

    this.garden = null; // per-garden objects (rebuilt for every user)
    this.selected = null; // { dayIndex, mode }
    this.lastTooltipKey = '';

    this._initRenderer();
    this._initScene();
    this._initControls();
    this._bindEvents();
    this.resize();
    this._applyTheme(0);
    this.renderer.setAnimationLoop((time) => this._frame(time));
  }

  // ---- setup ---------------------------------------------------------------

  _initRenderer() {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true, // needed for the PNG download
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D garden. Drag to rotate, scroll or pinch to zoom.');
    renderer.domElement.setAttribute('role', 'img');
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.timer = new THREE.Timer();
    this.timer.connect(document);
  }

  _initScene() {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffffff, 60, 250);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 2000);

    // Screen-space gradient backdrop (drawn first, behind everything).
    this.bgUniforms = {
      topColor: { value: new THREE.Color() },
      bottomColor: { value: new THREE.Color() },
      glowColor: { value: new THREE.Color() },
      glowStrength: { value: 0 },
    };
    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.bgUniforms,
        vertexShader: BACKGROUND_VERTEX,
        fragmentShader: BACKGROUND_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      }),
    );
    background.renderOrder = -1000;
    background.frustumCulled = false;
    scene.add(background);

    // Stars (night only) on a sphere that follows the camera.
    this.glowTexture = makeGlowTexture();
    const starCount = 900;
    const starPos = new Float32Array(starCount * 3);
    const starCol = new Float32Array(starCount * 3);
    const rand = createRandom(99);
    for (let i = 0; i < starCount; i++) {
      randomDirection(rand).multiplyScalar(700).toArray(starPos, i * 3);
      _c.setScalar(0.35 + rand() * 0.65).toArray(starCol, i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    this.starMaterial = new THREE.PointsMaterial({
      size: 3.2 * this.renderer.getPixelRatio(),
      sizeAttenuation: false,
      map: this.glowTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMaterial);
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    // Lights
    this.hemi = new THREE.HemisphereLight();
    scene.add(this.hemi);
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 4;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    this.sun = sun;
    this.shadowHelperCamera = new THREE.OrthographicCamera();

    // Drifting clouds around and below the island.
    // Emissive so they stay soft and white instead of picking up the warm ground bounce.
    this.cloudMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0xffffff });
    const cloudRand = createRandom(4242);
    const cloudGeos = [buildCloud(cloudRand), buildCloud(cloudRand), buildCloud(cloudRand)];
    this.clouds = [];
    const halfW = (MAX_WEEKS * SPACING) / 2;
    for (let i = 0; i < 7; i++) {
      const mesh = new THREE.Mesh(cloudGeos[i % cloudGeos.length], this.cloudMaterial);
      mesh.userData = {
        angle: (i / 7) * TAU + cloudRand() * 0.5,
        rx: halfW + 10 + cloudRand() * 8,
        rz: 14 + cloudRand() * 8,
        y: range(cloudRand, -9, -4),
        speed: (0.012 + cloudRand() * 0.01) * (i % 2 ? 1 : -1),
        bob: cloudRand() * TAU,
      };
      mesh.scale.setScalar(range(cloudRand, 0.8, 1.2));
      this.clouds.push(mesh);
      scene.add(mesh);
    }

    // Hover / selection marker: a square ring floating over a tile.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.56, 0.8, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, fog: false, toneMapped: false }),
    );
    this.marker.visible = false;
    this.marker.renderOrder = 10;
    scene.add(this.marker);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

  _initControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.minPolarAngle = 0.15;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.8;
    controls.autoRotateSpeed = 0.6;
    controls.enabled = false;
    controls.addEventListener('start', () => {
      this.dragging = true;
      this.intro = null;
      this._markInteraction();
    });
    controls.addEventListener('change', () => {
      // Only real camera moves count (a tap also fires 'start').
      if (this.dragging) this.userMovedCamera = true;
    });
    controls.addEventListener('end', () => {
      this.dragging = false;
      this._markInteraction();
    });
    this.controls = controls;
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    const activePointers = new Set();
    let down = null;

    el.addEventListener('pointerdown', (e) => {
      activePointers.add(e.pointerId);
      // e.timeStamp is when the input happened, so a janky frame can't turn a tap into a "long press".
      down = activePointers.size === 1 ? { x: e.clientX, y: e.clientY, time: e.timeStamp } : null;
      this._markInteraction();
    });
    el.addEventListener('pointermove', (e) => {
      this._markInteraction();
      if (e.pointerType === 'mouse') {
        this._setPointer(e);
        this.pickPending = true;
      }
    });
    const release = (e) => {
      activePointers.delete(e.pointerId);
      if (e.type !== 'pointerup' || !down || !this.interactive) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = e.timeStamp - down.time < 600;
      down = null;
      if (moved < 8 && quick && e.pointerType !== 'mouse') this._tap(e);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && this.selected?.mode === 'hover') this._select(null);
    });
    el.addEventListener('webglcontextlost', (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
  }

  // ---- public API ----------------------------------------------------------

  /** Builds a new garden for `data` (see data.js) and starts the grow animation. */
  setGarden(data, { animate = true, intro = true } = {}) {
    this._clearGarden();
    const rand = createRandom(data.seed);
    const days = data.days;
    const halfW = (data.weeks * SPACING) / 2;
    const halfD = (7 * SPACING) / 2;
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
    const spread = this.reducedMotion ? 0.6 : GROW_SPREAD;
    const pop = this.reducedMotion ? 0.3 : POP_DURATION;
    const startOf = (day) => (days.length > 1 ? (day.index / (days.length - 1)) * spread : 0);

    const g = {
      data,
      group,
      halfW,
      halfD,
      spread,
      pop,
      tiles: null,
      batches: [],
      pickables: [],
      fireflies: null,
      growthStart: this.timer.getElapsed(),
      growing: animate,
    };

    // Island
    const island = new THREE.Mesh(buildIsland(halfW + ISLAND_MARGIN, halfD + ISLAND_MARGIN, rand), material);
    island.receiveShadow = true;
    island.castShadow = true;
    group.add(island);

    // Tiles: one per day, dirt that turns grassy as the day grows.
    const tileGeo = finalize(new THREE.CylinderGeometry(0.6, 0.64, TILE_HEIGHT, 4, 1).rotateY(Math.PI / 4).translate(0, TILE_HEIGHT / 2, 0), '#ffffff');
    const tileMesh = new THREE.InstancedMesh(tileGeo, material, days.length);
    tileMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tileMesh.receiveShadow = true;
    tileMesh.castShadow = true;
    const tiles = {
      mesh: tileMesh,
      x: new Float32Array(days.length),
      y: new Float32Array(days.length),
      z: new Float32Array(days.length),
      start: new Float32Array(days.length),
      dirt: [],
      grass: [],
      dayIndex: new Int32Array(days.length),
    };
    days.forEach((day, i) => {
      tiles.x[i] = (day.week - (data.weeks - 1) / 2) * SPACING;
      tiles.z[i] = (day.weekday - 3) * SPACING;
      tiles.y[i] = (rand() - 0.5) * 0.03;
      tiles.start[i] = startOf(day);
      tiles.dayIndex[i] = i;
      const dirt = new THREE.Color(pick(rand, DIRT));
      tiles.dirt.push(dirt);
      tiles.grass.push(day.level > 0 ? new THREE.Color(GRASS_TILES[day.level]).multiplyScalar(0.94 + rand() * 0.1) : dirt);
      tileMesh.setColorAt(i, dirt);
    });
    tileMesh.userData.dayIndices = tiles.dayIndex;
    g.tiles = tiles;
    group.add(tileMesh);
    g.pickables.push(tileMesh);

    // Plants: choose a type per planted day, then one InstancedMesh per type/variant/part.
    const buckets = new Map();
    for (const day of days) {
      if (day.level === 0) continue;
      const options = PLANT_TYPES.filter((t) => t.level === day.level);
      const type = pick(rand, options);
      const variant = Math.floor(rand() * type.variants);
      const key = `${type.key}:${variant}`;
      if (!buckets.has(key)) buckets.set(key, { type, variant, days: [] });
      buckets.get(key).days.push(day);
    }

    const fireflyTrees = [];
    for (const { type, variant, days: bucketDays } of buckets.values()) {
      const n = bucketDays.length;
      const geos = type.build(rand, variant);
      const batch = {
        meshes: [],
        dayIndex: new Int32Array(n),
        start: new Float32Array(n),
        pos: new Float32Array(n * 3),
        quat: new Float32Array(n * 4),
        scale: new Float32Array(n * 3),
        tile: new Int32Array(n),
      };
      bucketDays.forEach((day, i) => {
        const ti = day.index;
        const s = range(rand, type.scale[0], type.scale[1]);
        const sy = s * range(rand, 0.9, 1.12);
        batch.dayIndex[i] = day.index;
        batch.tile[i] = ti;
        batch.start[i] = tiles.start[ti] + 0.06;
        _v.set(
          tiles.x[ti] + (rand() - 0.5) * 0.24,
          tiles.y[ti] + TILE_HEIGHT,
          tiles.z[ti] + (rand() - 0.5) * 0.24,
        ).toArray(batch.pos, i * 3);
        _q.setFromEuler(_euler.set(0, rand() * TAU, 0)).toArray(batch.quat, i * 4);
        _s.set(s, sy, s).toArray(batch.scale, i * 3);
        if (type.fireflies) fireflyTrees.push({ x: _v.x, y: _v.y + 1.15 * sy, z: _v.z, s, start: batch.start[i] });
      });

      for (const part of ['base', 'tint']) {
        const geo = geos[part];
        if (!geo) continue;
        const mesh = new THREE.InstancedMesh(geo, material, n);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.dayIndices = batch.dayIndex;
        for (let i = 0; i < n; i++) {
          if (part === 'tint' && type.tints) _c.set(pick(rand, type.tints));
          else _c.setScalar(0.88 + rand() * 0.2);
          mesh.setColorAt(i, _c);
        }
        batch.meshes.push(mesh);
        group.add(mesh);
        g.pickables.push(mesh);
      }
      g.batches.push(batch);
    }

    this._buildDecor(g, rand, material);
    this._buildFireflies(g, fireflyTrees, rand);

    // Write final transforms once to get correct bounds for culling and raycasting,
    // then collapse everything back to the start of the animation.
    this._updateGrowth(g, Infinity);
    tileMesh.computeBoundingSphere();
    for (const batch of g.batches) for (const mesh of batch.meshes) mesh.computeBoundingSphere();
    if (animate) this._updateGrowth(g, 0);

    this.scene.add(group);
    this.garden = g;
    this._updateShadowCamera();
    this.fitView();
    if (intro && !this.reducedMotion) this._startIntro();
    this._markInteraction();
  }

  /** Restarts the growth animation of the current garden. */
  replay() {
    const g = this.garden;
    if (!g) return;
    g.growthStart = this.timer.getElapsed();
    g.growing = true;
    this._updateGrowth(g, 0);
  }

  setNight(isNight, { instant = false } = {}) {
    this.nightTarget = isNight ? 1 : 0;
    if (instant) {
      this.night = this.nightTarget;
      this._applyTheme(this.night);
    }
  }

  get isNight() {
    return this.nightTarget === 1;
  }

  /** Enables/disables camera controls and picking (off while the landing screen is up). */
  setInteractive(on) {
    this.interactive = on;
    this.controls.enabled = on;
    if (!on) this._select(null);
  }

  /** Screen-space margins (px) covered by UI, so the garden is framed in the visible area. */
  setInsets(insets) {
    const changed = ['top', 'right', 'bottom', 'left'].some((k) => Math.abs((insets[k] ?? 0) - this.insets[k]) > 1);
    if (!changed) return;
    this.insets = { top: 0, right: 0, bottom: 0, left: 0, ...insets };
    if (this.userMovedCamera) this._applyViewOffset();
    else this.fitView({ keepAzimuth: true });
  }

  clearSelection() {
    this._select(null);
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    if (this.garden && !this.userMovedCamera) this.fitView({ keepAzimuth: true });
    else this._applyViewOffset();
  }

  /** Frames the whole garden inside the un-obstructed part of the screen. */
  fitView({ keepAzimuth = false } = {}) {
    const g = this.garden;
    if (!g) return;
    this._applyViewOffset();
    const target = new THREE.Vector3(0, 0, 0);
    const points = this._framingPoints(g);
    let best = null;
    if (keepAzimuth) {
      const az = this._currentAzimuth();
      best = { az, dist: this._fitDistance(points, target, az) };
    } else {
      for (let az = AZIMUTH_MIN; az <= AZIMUTH_MAX + 1e-6; az += THREE.MathUtils.degToRad(4)) {
        const dist = this._fitDistance(points, target, az);
        // Slight preference for the classic low azimuth when sizes are similar.
        if (!best || dist < best.dist * 0.94) best = { az, dist };
      }
    }
    this.controls.target.copy(target);
    this.camera.position.setFromSphericalCoords(best.dist, POLAR, best.az).add(target);
    this.camera.lookAt(target);
    this.controls.minDistance = best.dist * 0.15;
    this.controls.maxDistance = best.dist * 1.7;
    this.controls.update();
    this.fitDistance = best.dist;
    this.fitAzimuth = best.az;
    this.userMovedCamera = false;
  }

  /** Renders a clean frame and returns it as a PNG blob, with an optional caption. */
  async toBlob(caption = '') {
    const markerVisible = this.marker.visible;
    this.marker.visible = false;
    this.camera.clearViewOffset(); // center the garden in the full image
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0);
    this.marker.visible = markerVisible;
    this._applyViewOffset();

    if (caption) {
      const scale = src.width / this.size.width;
      const size = Math.round(15 * scale);
      ctx.font = `600 ${size}px ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = this.isNight ? 'rgba(255,255,255,0.92)' : 'rgba(40,32,24,0.85)';
      ctx.shadowColor = this.isNight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)';
      ctx.shadowBlur = 6 * scale;
      ctx.fillText(caption, 20 * scale, src.height - 18 * scale);
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create PNG'))), 'image/png');
    });
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this._clearGarden();
    disposeObject(this.scene);
    this.glowTexture.dispose();
    this.timer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- per-garden building -----------------------------------------------

  _buildDecor(g, rand, material) {
    const { halfW, halfD, group } = g;
    const hx = halfW + ISLAND_MARGIN - 0.15;
    const hz = halfD + ISLAND_MARGIN - 0.15;
    const inside = (x, z) => Math.abs(x) < halfW + 0.05 && Math.abs(z) < halfD + 0.05;
    const scatter = (count) => {
      const out = [];
      for (let tries = 0; out.length < count && tries < count * 20; tries++) {
        const x = (rand() * 2 - 1) * hx;
        const z = (rand() * 2 - 1) * hz;
        if (!inside(x, z)) out.push([x, z]);
      }
      return out;
    };

    const pebbleGeo = finalize(blob(rand, 1, 0, 0.25), '#ffffff');
    const pebbleSpots = scatter(46);
    const pebbles = new THREE.InstancedMesh(pebbleGeo, material, pebbleSpots.length);
    pebbleSpots.forEach(([x, z], i) => {
      const s = range(rand, 0.06, 0.15);
      pebbles.setMatrixAt(i, _m.compose(_v.set(x, 0.01, z), _q.setFromEuler(_euler.set(0, rand() * TAU, 0)), _s.set(s, s * 0.6, s)));
      pebbles.setColorAt(i, _c.set(pick(rand, PEBBLE_COLORS)));
    });
    pebbles.castShadow = true;
    pebbles.receiveShadow = true;
    group.add(pebbles);

    const tuftGeo = buildSprouts(rand).base;
    const tuftSpots = scatter(70);
    const tufts = new THREE.InstancedMesh(tuftGeo, material, tuftSpots.length);
    tuftSpots.forEach(([x, z], i) => {
      const s = range(rand, 0.4, 0.75);
      tufts.setMatrixAt(i, _m.compose(_v.set(x, 0, z), _q.setFromEuler(_euler.set(0, rand() * TAU, 0)), _s.set(s, s, s)));
      tufts.setColorAt(i, _c.setScalar(0.8 + rand() * 0.25));
    });
    tufts.castShadow = true;
    group.add(tufts);
  }

  _buildFireflies(g, trees, rand) {
    if (trees.length === 0) return;
    const perTree = 4;
    const count = Math.min(trees.length * perTree, 900);
    const params = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      const tree = trees[Math.floor(i / perTree) % trees.length];
      params.set(
        [
          tree.x,
          tree.y,
          tree.z,
          (0.5 + rand() * 0.45) * tree.s, // orbit radius
          (0.35 + rand() * 0.5) * (rand() < 0.5 ? -1 : 1), // angular speed
          rand() * TAU, // phase
          2 + rand() * 4, // flicker speed
          tree.start,
        ],
        i * 8,
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.PointsMaterial({
      size: 1.2,
      map: this.glowTexture,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;
    g.group.add(points);
    g.fireflies = { points, params, count };
  }

  _clearGarden() {
    const g = this.garden;
    if (!g) return;
    this._select(null);
    this.scene.remove(g.group);
    disposeObject(g.group);
    this.garden = null;
  }

  // ---- animation -----------------------------------------------------------

  _frame(timestamp) {
    this.timer.update(timestamp);
    const rawDt = this.timer.getDelta();
    const dt = Math.min(rawDt, 0.1); // for physics-ish motion; fades use real time
    const t = this.timer.getElapsed();
    const g = this.garden;

    // Day / night cross-fade
    if (this.night !== this.nightTarget) {
      const step = rawDt / (this.reducedMotion ? 0.25 : THEME_DURATION);
      this.night = this.nightTarget > this.night ? Math.min(1, this.night + step) : Math.max(0, this.night - step);
      this._applyTheme(smoothstep(this.night));
    }

    if (g?.growing) {
      const local = t - g.growthStart;
      this._updateGrowth(g, local);
      if (local > g.spread + g.pop + 0.1) {
        this._updateGrowth(g, Infinity);
        g.growing = false;
      }
    }
    if (g?.fireflies) this._updateFireflies(g, t);

    for (const cloud of this.clouds) {
      const d = cloud.userData;
      d.angle += d.speed * dt;
      cloud.position.set(Math.cos(d.angle) * d.rx, d.y + Math.sin(t * 0.4 + d.bob) * 0.25, Math.sin(d.angle) * d.rz);
      cloud.rotation.y = -d.angle;
    }

    if (this.marker.visible) this.marker.material.opacity = 0.65 + Math.sin(t * 5) * 0.25;

    // Camera: intro fly-in, then idle auto-rotation.
    if (this.intro) this._updateIntro(t);
    const idle = t - this.lastInteraction > IDLE_BEFORE_ROTATE;
    const rotate = this.interactive ? idle && !this.reducedMotion && !this.intro : !this.reducedMotion;
    if (rotate && !this.controls.autoRotate && this.selected?.mode === 'hover') this._select(null);
    this.controls.autoRotate = rotate;
    this.controls.update(dt);
    this._clampTarget();
    this.stars.position.copy(this.camera.position);

    const dist = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.near = dist * 0.9 + 10;
    this.scene.fog.far = dist * 3 + 60;

    if (this.pickPending && this.interactive && !this.dragging) {
      this.pickPending = false;
      const dayIndex = this._pick();
      this._select(dayIndex === null ? null : { dayIndex, mode: 'hover' });
    }
    this._emitTooltip();

    this.renderer.render(this.scene, this.camera);
  }

  _updateGrowth(g, local) {
    const { tiles, pop } = g;
    const tileMesh = tiles.mesh;
    for (let i = 0; i < tiles.x.length; i++) {
      const p = clamp01((local - tiles.start[i]) / HOP_DURATION);
      const hop = p > 0 && p < 1 ? Math.sin(p * Math.PI) * 0.14 : 0;
      _m.makeTranslation(tiles.x[i], tiles.y[i] + hop, tiles.z[i]);
      tileMesh.setMatrixAt(i, _m);
      tileMesh.setColorAt(i, _c.lerpColors(tiles.dirt[i], tiles.grass[i], clamp01(p * 1.5)));
    }
    tileMesh.instanceMatrix.needsUpdate = true;
    tileMesh.instanceColor.needsUpdate = true;

    for (const batch of g.batches) {
      for (let i = 0; i < batch.start.length; i++) {
        const p = clamp01((local - batch.start[i]) / pop);
        const grow = p >= 1 ? 1 : easeOutBack(p);
        const tp = clamp01((local - tiles.start[batch.tile[i]]) / HOP_DURATION);
        const hop = tp > 0 && tp < 1 ? Math.sin(tp * Math.PI) * 0.14 : 0;
        _v.fromArray(batch.pos, i * 3);
        _v.y += hop;
        _q.fromArray(batch.quat, i * 4);
        _s.fromArray(batch.scale, i * 3).multiplyScalar(Math.max(grow, 0));
        _m.compose(_v, _q, _s);
        for (const mesh of batch.meshes) mesh.setMatrixAt(i, _m);
      }
      for (const mesh of batch.meshes) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _updateFireflies(g, t) {
    const ff = g.fireflies;
    const visible = this.night > 0.01;
    ff.points.visible = visible;
    if (!visible) return;
    const local = g.growing ? t - g.growthStart : Infinity;
    const pos = ff.points.geometry.attributes.position;
    const col = ff.points.geometry.attributes.color;
    const glow = smoothstep(this.night);
    for (let i = 0; i < ff.count; i++) {
      const o = i * 8;
      const p = ff.params;
      const angle = p[o + 5] + t * p[o + 4];
      const r = p[o + 3] * (1 + Math.sin(t * 0.7 + p[o + 5]) * 0.25);
      pos.setXYZ(i, p[o] + Math.cos(angle) * r, p[o + 1] + Math.sin(t * 1.3 + p[o + 5] * 2) * 0.35, p[o + 2] + Math.sin(angle) * r);
      const grown = clamp01((local - p[o + 7]) / 0.6);
      const flicker = 0.5 + 0.5 * Math.sin(t * p[o + 6] + p[o + 5]) ** 2;
      _c.copy(FIREFLY_COLOR).multiplyScalar(1.6 * flicker * grown * glow);
      col.setXYZ(i, _c.r, _c.g, _c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  _applyTheme(f) {
    const d = this.themes.day;
    const n = this.themes.night;
    this.bgUniforms.topColor.value.lerpColors(d.bgTop, n.bgTop, f);
    this.bgUniforms.bottomColor.value.lerpColors(d.bgBottom, n.bgBottom, f);
    this.bgUniforms.glowColor.value.lerpColors(d.glow, n.glow, f);
    this.bgUniforms.glowStrength.value = lerp(d.glowStrength, n.glowStrength, f);
    this.scene.fog.color.lerpColors(d.fog, n.fog, f);
    this.hemi.color.lerpColors(d.hemiSky, n.hemiSky, f);
    this.hemi.groundColor.lerpColors(d.hemiGround, n.hemiGround, f);
    this.hemi.intensity = lerp(d.hemiIntensity, n.hemiIntensity, f);
    this.sun.color.lerpColors(d.light, n.light, f);
    this.sun.intensity = lerp(d.lightIntensity, n.lightIntensity, f);
    this.sun.position.lerpVectors(d.lightDir, n.lightDir, f).normalize().multiplyScalar(60);
    this.sun.shadow.intensity = lerp(d.shadowIntensity, n.shadowIntensity, f);
    this.renderer.toneMappingExposure = lerp(d.exposure, n.exposure, f);
    this.starMaterial.opacity = f;
    this.cloudMaterial.emissiveIntensity = lerp(0.42, 0.06, f);
    this._updateShadowCamera();
  }

  /** Fits the directional light's shadow frustum tightly around the island. */
  _updateShadowCamera() {
    const g = this.garden;
    const hx = (g ? g.halfW : (MAX_WEEKS * SPACING) / 2) + ISLAND_MARGIN + 0.3;
    const hz = (g ? g.halfD : 3.5 * SPACING) + ISLAND_MARGIN + 0.3;
    const helper = this.shadowHelperCamera;
    helper.position.copy(this.sun.position);
    helper.lookAt(this.sun.target.position);
    helper.updateMatrixWorld(true);
    const inv = helper.matrixWorldInverse;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const x of [-hx, hx]) {
      for (const y of [-SOIL_DEPTH - 0.2, PLANT_TOP + 0.5]) {
        for (const z of [-hz, hz]) {
          _v.set(x, y, z).applyMatrix4(inv);
          minX = Math.min(minX, _v.x);
          maxX = Math.max(maxX, _v.x);
          minY = Math.min(minY, _v.y);
          maxY = Math.max(maxY, _v.y);
          minZ = Math.min(minZ, _v.z);
          maxZ = Math.max(maxZ, _v.z);
        }
      }
    }
    const cam = this.sun.shadow.camera;
    cam.left = minX - 0.5;
    cam.right = maxX + 0.5;
    cam.bottom = minY - 0.5;
    cam.top = maxY + 0.5;
    cam.near = Math.max(0.1, -maxZ - 2);
    cam.far = -minZ + 2;
    cam.updateProjectionMatrix();
  }

  // ---- camera --------------------------------------------------------------

  _framingPoints(g) {
    const hx = g.halfW + ISLAND_MARGIN;
    const hz = g.halfD + ISLAND_MARGIN;
    const points = [];
    for (const x of [-hx, hx]) {
      for (const z of [-hz, hz]) {
        points.push(new THREE.Vector3(x, PLANT_TOP, z), new THREE.Vector3(x, -0.16 - SOIL_DEPTH, z));
        points.push(new THREE.Vector3(x * 0.35, -0.16 - SOIL_DEPTH - UNDERSIDE_DEPTH * 0.75, z * 0.35));
      }
    }
    return points;
  }

  _safeNdc() {
    const { width, height } = this.size;
    const ins = this.insets;
    return {
      left: ((ins.left + VIEW_PADDING) / width) * 2 - 1,
      right: 1 - ((ins.right + VIEW_PADDING) / width) * 2,
      bottom: ((ins.bottom + VIEW_PADDING) / height) * 2 - 1,
      top: 1 - ((ins.top + VIEW_PADDING) / height) * 2,
    };
  }

  _fitDistance(points, target, azimuth) {
    const safe = this._safeNdc();
    let lo = 1;
    let hi = 2000;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      this.camera.position.setFromSphericalCoords(mid, POLAR, azimuth).add(target);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld(true);
      const fits = points.every((p) => {
        _v2.copy(p).project(this.camera);
        return _v2.z < 1 && _v2.x >= safe.left && _v2.x <= safe.right && _v2.y >= safe.bottom && _v2.y <= safe.top;
      });
      if (fits) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /** Shifts the projection so the orbit target sits in the middle of the un-obstructed area. */
  _applyViewOffset() {
    const { width, height } = this.size;
    const ins = this.insets;
    const dx = (ins.left - ins.right) / 2;
    const dy = (ins.top - ins.bottom) / 2;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(width, height, -dx, -dy, width, height);
    this.camera.updateProjectionMatrix();
  }

  _currentAzimuth() {
    _v.copy(this.camera.position).sub(this.controls.target);
    return Math.atan2(_v.x, _v.z);
  }

  _startIntro() {
    this.intro = {
      start: this.timer.getElapsed(),
      fromAz: this.fitAzimuth - 0.55,
      toAz: this.fitAzimuth,
      fromDist: this.fitDistance * 1.35,
      toDist: this.fitDistance,
      fromPolar: POLAR - 0.25,
    };
    this._updateIntro(this.intro.start);
  }

  _updateIntro(t) {
    const it = this.intro;
    const p = clamp01((t - it.start) / INTRO_DURATION);
    const e = easeOutCubic(p);
    this.camera.position
      .setFromSphericalCoords(lerp(it.fromDist, it.toDist, e), lerp(it.fromPolar, POLAR, e), lerp(it.fromAz, it.toAz, e))
      .add(this.controls.target);
    if (p >= 1) {
      this.intro = null;
      this._markInteraction();
    }
  }

  _clampTarget() {
    const g = this.garden;
    if (!g) return;
    const t = this.controls.target;
    _v.set(
      THREE.MathUtils.clamp(t.x, -g.halfW, g.halfW),
      THREE.MathUtils.clamp(t.y, -0.5, 1.5),
      THREE.MathUtils.clamp(t.z, -g.halfD, g.halfD),
    );
    if (_v.equals(t)) return;
    _v.sub(t);
    t.add(_v);
    this.camera.position.add(_v);
  }

  _markInteraction() {
    this.lastInteraction = this.timer.getElapsed();
  }

  // ---- picking & tooltip ---------------------------------------------------

  _setPointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerClient = { x: e.clientX, y: e.clientY };
  }

  /** @returns {number|null} day index under the pointer */
  _pick() {
    const g = this.garden;
    if (!g) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(g.pickables, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    return hit.object.userData.dayIndices[hit.instanceId];
  }

  _tap(e) {
    this._setPointer(e);
    const dayIndex = this._pick();
    if (dayIndex === null || dayIndex === this.selected?.dayIndex) this._select(null);
    else this._select({ dayIndex, mode: 'tap' });
  }

  _select(selection) {
    const g = this.garden;
    this.selected = selection && g ? selection : null;
    if (this.selected) {
      const i = this.selected.dayIndex;
      this.marker.position.set(g.tiles.x[i], g.tiles.y[i] + TILE_HEIGHT + 0.015, g.tiles.z[i]);
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }
  }

  _emitTooltip() {
    const sel = this.selected;
    const g = this.garden;
    if (!sel || !g) {
      if (this.lastTooltipKey !== '') {
        this.lastTooltipKey = '';
        this.onTooltip?.(null);
      }
      return;
    }
    let x;
    let y;
    if (sel.mode === 'hover' && this.pointerClient) {
      ({ x, y } = this.pointerClient);
    } else {
      // Anchor above the tile so it follows the camera.
      const i = sel.dayIndex;
      _v.set(g.tiles.x[i], g.tiles.y[i] + TILE_HEIGHT + 0.4, g.tiles.z[i]).project(this.camera);
      const rect = this.renderer.domElement.getBoundingClientRect();
      x = rect.left + ((_v.x + 1) / 2) * rect.width;
      y = rect.top + ((1 - _v.y) / 2) * rect.height;
      if (_v.z > 1) {
        this._select(null);
        return;
      }
    }
    const key = `${sel.dayIndex}|${sel.mode}|${Math.round(x)}|${Math.round(y)}`;
    if (key === this.lastTooltipKey) return;
    this.lastTooltipKey = key;
    this.onTooltip?.({ day: g.data.days[sel.dayIndex], x, y, mode: sel.mode });
  }
}
