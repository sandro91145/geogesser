// Street view: finding 360° panoramas and showing them.
//
// Sources
//   Panoramax  — open street-level imagery, no key. data/coverage.json lists spots
//                with 360° coverage (from Panoramax's coverage grid); each round
//                searches one of them.
//   Mapillary  — worldwide crowdsourced imagery; used when js/config.js has a token.
//                Each round reads Mapillary's coverage tile around a seed point and
//                picks a 360° sequence from it.
//
// A pano looks like:
//   { kind: 'pano', source: 'panoramax'|'mapillary', id, lat, lng, heading, src,
//     author, license, page, seq?, next?, prev? }

import { MAPILLARY_TOKEN } from './config.js?v=11';

const PANORAMAX = 'https://api.panoramax.xyz/api';
const MLY_GRAPH = 'https://graph.mapillary.com';
const MLY_TILES = 'https://tiles.mapillary.com/maps/vtp/mly1_public/2';
const PSV = 'https://cdn.jsdelivr.net/npm/@photo-sphere-viewer';
const PSV_VERSION = '5.15.1';

export const hasMapillary = () => /^MLY\|/.test(MAPILLARY_TOKEN);

/* ---------------- small helpers ---------------- */
async function getJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export function preloadPano(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(src);
    img.onerror = () => reject(new Error('panorama failed to load'));
    img.src = src;
  });
}

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
export function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function metres(a, b) {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function jitterKm([lat, lng], maxKm, rnd = Math.random) {
  const d = Math.sqrt(rnd()) * maxKm, th = rnd() * 2 * Math.PI;
  return [lat + (d * Math.cos(th)) / 111, lng + (d * Math.sin(th)) / (111 * Math.max(0.2, Math.cos(toRad(lat))))];
}
const inBoxes = (boxes, [lat, lng]) => !boxes || boxes.some(([s, n, w, e]) => lat >= s && lat <= n && lng >= w && lng <= e);

/* ---------------- Panoramax ---------------- */
let coveragePromise = null;
function loadCoverage() {
  coveragePromise ||= getJSON('data/coverage.json?v=11', 10000).then((d) => d.points).catch((e) => { coveragePromise = null; throw e; });
  return coveragePromise;
}

const isFull360 = (f) => (f?.properties?.['pers:interior_orientation']?.field_of_view ?? 0) >= 360;
const licenseName = (l) => (l || '').replace(/-/g, ' ').replace(/^CC (BY|BY SA|BY ND|BY NC.*|0) (\d\.\d)$/i, 'CC $1 $2').replace(/BY SA/i, 'BY-SA');

function panoFromPanoramax(f) {
  const [lng, lat] = f.geometry.coordinates;
  const author = f.providers?.find((p) => p.roles?.includes('producer'))?.name || f.properties['geovisio:producer'] || 'a Panoramax contributor';
  return {
    kind: 'pano', source: 'panoramax', id: f.id, lat, lng,
    heading: Number(f.properties['view:azimuth']) || 0,
    src: (f.assets.sd || f.assets.hd).href,
    author, license: licenseName(f.properties.license),
    page: `https://api.panoramax.xyz/#focus=pic&pic=${f.id}&map=17/${lat}/${lng}`,
    nextUrl: f.links?.find((l) => l.rel === 'next')?.href || null,
    prevUrl: f.links?.find((l) => l.rel === 'prev')?.href || null,
  };
}

// Pick a coverage spot for the region and return 360° pictures found around it.
export async function panoramaxCandidates(region, rnd = Math.random) {
  const points = (await loadCoverage()).filter((p) => inBoxes(region.boxes, p));
  if (!points.length) return [];
  let pool = points;
  if (!region.boxes) {
    // World: pick a continent first (weighted by √coverage) so Europe doesn't dominate.
    const groups = region.continents.map((boxes) => points.filter((p) => inBoxes(boxes, p))).filter((g) => g.length);
    const weights = groups.map((g) => Math.sqrt(g.length));
    let r = rnd() * weights.reduce((a, b) => a + b, 0);
    pool = groups.find((g, i) => (r -= weights[i]) <= 0) || groups[0];
  }
  const [lat, lng] = pool[Math.floor(rnd() * pool.length)];
  const d = 0.06;
  const data = await getJSON(`${PANORAMAX}/search?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&limit=200`, 9000);
  return (data.features || []).filter(isFull360).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export async function findPanoramax(region, used, rnd = Math.random) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const list = (await panoramaxCandidates(region, rnd)).filter((f) => !used.has(f.id));
    if (!list.length) continue;
    const f = list[Math.floor(rnd() * list.length)];
    const pano = panoFromPanoramax(f);
    await preloadPano(pano.src);
    return pano;
  }
  throw new Error('No Panoramax panorama found');
}

async function panoramaxById(id) {
  const data = await getJSON(`${PANORAMAX}/search?ids=${encodeURIComponent(id)}`);
  const f = data.features?.[0];
  if (!f) throw new Error('Panorama not found');
  return panoFromPanoramax(f);
}

async function panoramaxStep(pano, dir) {
  let url = dir === 'next' ? pano.nextUrl : pano.prevUrl;
  let hop = null;
  // Steps can be a few metres apart; hop up to 3 pictures to move ~10 m like a real step.
  for (let i = 0; i < 3 && url; i++) {
    const f = await getJSON(url, 8000);
    if (!isFull360(f)) break;
    hop = panoFromPanoramax(f);
    if (metres(pano, hop) >= 8) break;
    url = dir === 'next' ? hop.nextUrl : hop.prevUrl;
  }
  return hop;
}

/* ---------------- Mapillary ---------------- */
let mvtLib = null;
async function loadMvt() {
  mvtLib ||= Promise.all([
    import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@3.0.0/+esm'),
    import('https://cdn.jsdelivr.net/npm/pbf@5.1.2/+esm'),
  ]).then(([vt, pbf]) => ({ VectorTile: vt.VectorTile, PbfReader: pbf.PbfReader }));
  return mvtLib;
}
function tileXY(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}
const MLY_FIELDS = 'id,computed_geometry,geometry,computed_compass_angle,compass_angle,thumb_2048_url,is_pano,creator,sequence';

function panoFromMapillary(img) {
  const [lng, lat] = (img.computed_geometry || img.geometry).coordinates;
  return {
    kind: 'pano', source: 'mapillary', id: img.id, lat, lng,
    heading: Number(img.computed_compass_angle ?? img.compass_angle) || 0,
    src: img.thumb_2048_url,
    author: img.creator?.username || 'a Mapillary contributor',
    license: 'CC BY-SA 4.0',
    page: `https://www.mapillary.com/app/?pKey=${img.id}&focus=photo`,
    seq: img.sequence,
  };
}

async function mapillaryImage(id) {
  return getJSON(`${MLY_GRAPH}/${id}?access_token=${encodeURIComponent(MAPILLARY_TOKEN)}&fields=${MLY_FIELDS}`);
}

const mlySeqCache = new Map();
async function sequenceIds(seq) {
  if (!mlySeqCache.has(seq)) {
    const d = await getJSON(`${MLY_GRAPH}/image_ids?access_token=${encodeURIComponent(MAPILLARY_TOKEN)}&sequence_id=${seq}`);
    mlySeqCache.set(seq, (d.data || []).map((x) => String(x.id)));
  }
  return mlySeqCache.get(seq);
}

export async function findMapillary(region, used, rnd = Math.random) {
  const { VectorTile, PbfReader } = await loadMvt();
  for (let attempt = 0; attempt < 6; attempt++) {
    const seed = region.seeds[Math.floor(rnd() * region.seeds.length)];
    const [lat, lng] = jitterKm(seed, region.jitter * 1.5, rnd);
    const z = 11;  // ~20 km tiles: enough coverage, quick to load even in big cities
    const [x, y] = tileXY(lat, lng, z);
    let layer;
    try {
      const res = await fetch(`${MLY_TILES}/${z}/${x}/${y}?access_token=${encodeURIComponent(MAPILLARY_TOKEN)}`);
      if (!res.ok) continue;
      layer = new VectorTile(new PbfReader(await res.arrayBuffer())).layers.sequence;
    } catch { continue; }
    if (!layer) continue;
    const seqs = [];
    for (let i = 0; i < layer.length; i++) {
      const p = layer.feature(i).properties;
      if ((p.is_pano === true || p.is_pano === 1 || p.is_pano === 'true') && p.id && !used.has('seq:' + p.id)) seqs.push(p);
    }
    if (!seqs.length) continue;
    const pick = seqs[Math.floor(rnd() * seqs.length)];
    try {
      // Start somewhere in the middle of the street, not at the first photo.
      const ids = await sequenceIds(pick.id);
      const id = ids.length > 4 ? ids[Math.floor(ids.length * (0.2 + 0.6 * rnd()))] : String(pick.image_id);
      const img = await mapillaryImage(id);
      if (!img.is_pano || !img.thumb_2048_url) continue;
      const pano = panoFromMapillary(img);
      await preloadPano(pano.src);
      used.add('seq:' + pick.id);
      return pano;
    } catch { /* try another tile */ }
  }
  throw new Error('No Mapillary panorama found');
}

async function mapillaryStep(pano, dir) {
  if (!pano.seq) return null;
  const ids = await sequenceIds(pano.seq);
  let i = ids.indexOf(String(pano.id));
  if (i < 0) return null;
  // Hop along the sequence until ~8 m away (max 3 images).
  let hop = null;
  for (let k = 0; k < 3; k++) {
    i += dir === 'next' ? 1 : -1;
    if (i < 0 || i >= ids.length) break;
    const img = await mapillaryImage(ids[i]);
    if (!img.is_pano) break;
    hop = panoFromMapillary(img);
    if (metres(pano, hop) >= 8) break;
  }
  return hop;
}

/* ---------------- public: find / load / step ---------------- */
export async function findPano(region, used, rnd = Math.random) {
  const tries = [];
  if (hasMapillary()) tries.push(findMapillary);
  tries.push(findPanoramax);
  // In Europe, Panoramax is strong too: mix it in a quarter of the time.
  if (tries.length === 2 && rnd() < 0.25) tries.reverse();
  let lastErr;
  for (const fn of tries) {
    try { return await fn(region, used, rnd); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No panorama found');
}

export async function panoFromSpec([kind, id]) {
  if (kind === 'x') return panoramaxById(id);
  if (kind === 'm') return panoFromMapillary(await mapillaryImage(id));
  throw new Error('Unknown panorama');
}
export const panoSpec = (p) => [p.source === 'mapillary' ? 'm' : 'x', String(p.id)];

export async function stepPano(pano, dir) {
  try {
    return pano.source === 'mapillary' ? await mapillaryStep(pano, dir) : await panoramaxStep(pano, dir);
  } catch { return null; }
}

/* ---------------- viewer ---------------- */
let libs = null;
function loadViewerLibs() {
  libs ||= Promise.all([
    import(`${PSV}/core@${PSV_VERSION}/+esm`),
    import(`${PSV}/markers-plugin@${PSV_VERSION}/+esm`),
  ]);
  return libs;
}

export class StreetViewer {
  constructor(container, { onHeading, onMove } = {}) {
    this.container = container;
    this.onHeading = onHeading;
    this.onMove = onMove;
    this.pano = null;
    this.start = null;
    this.mode = 'move';
    this.busy = false;
    this.neighbours = { next: null, prev: null };
  }

  async init() {
    if (this.viewer) return;
    const [{ Viewer }, { MarkersPlugin }] = await loadViewerLibs();
    this.viewer = new Viewer({
      container: this.container,
      navbar: false,
      loadingTxt: '',
      defaultZoomLvl: 0,
      minFov: 30,
      maxFov: 100,
      mousewheelCtrlKey: false,
      touchmoveTwoFingers: false,
      keyboard: 'always',
      // Up/Down (and W/S) walk; the game handles those keys itself.
      keyboardActions: { ArrowLeft: 'ROTATE_LEFT', ArrowRight: 'ROTATE_RIGHT', PageUp: 'ZOOM_IN', PageDown: 'ZOOM_OUT', '+': 'ZOOM_IN', '-': 'ZOOM_OUT' },
      plugins: [[MarkersPlugin, {}]],
    });
    this.markers = this.viewer.getPlugin(MarkersPlugin);
    this.viewer.addEventListener('position-updated', ({ position }) => this.emitHeading(position.yaw));
    this.markers.addEventListener('select-marker', ({ marker }) => this.step(marker.id));
  }

  emitHeading(yaw = this.viewer.getPosition().yaw) {
    if (!this.pano) return;
    this.onHeading?.(((this.pano.heading + toDeg(yaw)) % 360 + 360) % 360);
  }

  setMode(mode) {
    this.mode = mode; // 'move' | 'nomove' | 'nmpz'
    if (!this.viewer) return;
    const fixed = mode === 'nmpz';
    this.viewer.setOptions({ mousemove: !fixed, mousewheel: !fixed, keyboard: fixed ? false : 'always' });
  }

  // Show a pano. `lookAt` is a compass heading to face (keeps direction when walking).
  async show(pano, { lookAt = null, first = false, transition = false } = {}) {
    await this.init();
    this.pano = pano;
    if (first) this.start = pano;
    const yaw = lookAt == null ? 0 : toRad(lookAt - pano.heading);
    this.markers.clearMarkers();
    const opts = {
      position: { yaw, pitch: 0 },
      transition: transition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 400 : false,
      showLoader: !transition,
    };
    if (first) opts.zoom = 0;
    await this.viewer.setPanorama(pano.src, opts);
    this.emitHeading(yaw);
    if (this.mode === 'move') this.loadArrows(pano);
  }

  async loadArrows(pano) {
    this.neighbours = { next: null, prev: null };
    const [next, prev] = await Promise.all([stepPano(pano, 'next'), stepPano(pano, 'prev')]);
    if (this.pano !== pano) return; // moved on meanwhile
    this.neighbours = { next, prev };
    for (const [id, target] of Object.entries(this.neighbours)) {
      if (!target) continue;
      const yaw = toRad(bearing(pano, target) - pano.heading);
      this.markers.addMarker({
        id, position: { yaw, pitch: -0.42 },
        html: '<span class="pano-arrow" aria-hidden="true"></span>',
        size: { width: 64, height: 64 }, anchor: 'center center',
      });
    }
  }

  async step(dir) {
    if (this.busy || this.mode !== 'move') return;
    const target = this.neighbours[dir];
    if (!target) return;
    this.busy = true;
    try {
      const facing = this.currentHeading();
      await preloadPano(target.src);
      await this.show(target, { lookAt: facing, transition: true });
      this.onMove?.(target);
    } catch (e) { console.warn('Could not move:', e); } finally { this.busy = false; }
  }

  // Walk in the direction the player is looking (or away from it): pick whichever arrow is closer.
  stepForward(backwards = false) {
    if (!this.pano) return;
    const facing = (this.currentHeading() + (backwards ? 180 : 0)) % 360;
    let best = null, bestDiff = 999;
    for (const [dir, t] of Object.entries(this.neighbours)) {
      if (!t) continue;
      const diff = Math.abs(((bearing(this.pano, t) - facing + 540) % 360) - 180);
      if (diff < bestDiff) { best = dir; bestDiff = diff; }
    }
    if (best && bestDiff < 100) this.step(best);
  }

  currentHeading() {
    return ((this.pano.heading + toDeg(this.viewer.getPosition().yaw)) % 360 + 360) % 360;
  }

  async backToStart() {
    if (!this.start || this.busy || this.pano === this.start) return;
    await this.show(this.start, { lookAt: this.currentHeading() });
    this.onMove?.(this.start);
  }

  faceNorth() {
    if (!this.viewer || !this.pano) return;
    this.viewer.animate({ yaw: toRad(-this.pano.heading), pitch: 0, speed: '20rpm' });
  }

  resize() { this.viewer?.autoSize?.(); }
}
