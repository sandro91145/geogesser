import { REGIONS } from './seeds.js';

const ROUNDS = 5;
const MAX_POINTS = 5000;
const API = 'https://commons.wikimedia.org/w/api.php';
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

// File names that usually mean "not a photo of a place".
const BAD_TITLE = /\b(map|maps|karte|carte|mapa|plan|lageplan|logo|flag|coat of arms|wappen|bras[aã]o|escudo|diagram|chart|scan|document|signature|stamp|coin|banknote|poster|book|page|letter|manuscript|screenshot|satellite|portrait|painting|museum|exhibit|artefact|artifact|fossil|specimen|herbarium|inscription|plaque|grave|tomb|interior|x-ray|microscop)\b/i;

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  regionKey: 'world',
  timerSecs: 0,
  round: 0,
  total: 0,
  results: [],           // { loc, guess, km, points }
  current: null,         // location for this round
  guess: null,           // L.LatLng
  usedTitles: new Set(),
  usedSeeds: new Set(),
  prefetch: null,        // Promise<location>
  timerId: null,
  deadline: 0,
  phase: 'idle',         // idle | loading | guessing | result | summary
};

/* ---------------- storage (best scores) ---------------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const bestKey = (region, timer) => `onde.best.${region}.${timer}`;

/* ---------------- helpers ---------------- */
const fmt = (n) => Math.round(n).toLocaleString('en-US');
function fmtKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${fmt(km)} km`;
}
function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const scoreFor = (km, scale) => (km < 0.05 ? MAX_POINTS : Math.round(MAX_POINTS * Math.exp(-km / scale)));
const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
function htmlToText(html, max = 240) {
  if (!html) return '';
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
function niceTitle(title) {
  return title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').trim();
}
const looksLikeCameraName = (t) => /^(img|dsc|dscf|dscn|pxl|p\d|photo|image|cimg|sam|gopr|dji)[\s_-]?\d/i.test(t) || /^\d[\d\s_-]*$/.test(t);

// Move a point a random distance (up to maxKm) in a random direction.
function jitter([lat, lng], maxKm) {
  const d = Math.sqrt(Math.random()) * maxKm;
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (d * Math.cos(theta)) / 111;
  const dLng = (d * Math.sin(theta)) / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [Math.max(-85, Math.min(85, lat + dLat)), ((lng + dLng + 540) % 360) - 180];
}

async function fetchJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function preloadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(src);
    img.onerror = () => reject(new Error('image failed'));
    img.src = src;
  });
}

/* ---------------- finding a location ---------------- */
async function searchNear([lat, lng]) {
  const p = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'geosearch', ggscoord: `${lat.toFixed(5)}|${lng.toFixed(5)}`, ggsradius: '10000', ggslimit: '50', ggsnamespace: '6',
    prop: 'imageinfo|coordinates', colimit: 'max',
    iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280',
    iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription',
  });
  const data = await fetchJSON(`${API}?${p}`);
  const pages = data?.query?.pages || [];
  return pages.filter((pg) => {
    const ii = pg.imageinfo?.[0];
    const co = pg.coordinates?.[0];
    if (!ii || !co || !ii.thumburl) return false;
    if (ii.mime !== 'image/jpeg') return false;
    if (ii.width < 1000 || ii.height < 600) return false;
    const ratio = ii.width / ii.height;
    if (ratio < 0.6 || ratio > 2.7) return false;
    if (BAD_TITLE.test(niceTitle(pg.title))) return false;
    if (state.usedTitles.has(pg.title)) return false;
    return true;
  }).map((pg) => {
    const ii = pg.imageinfo[0], md = ii.extmetadata || {};
    const name = niceTitle(pg.title);
    return {
      title: pg.title,
      name,
      lat: pg.coordinates[0].lat,
      lng: pg.coordinates[0].lon,
      src: ii.thumburl,
      page: ii.descriptionurl,
      artist: htmlToText(md.Artist?.value, 80) || 'Unknown author',
      license: htmlToText(md.LicenseShortName?.value, 40),
      desc: htmlToText(md.ImageDescription?.value),
    };
  });
}

async function findLocation() {
  const region = REGIONS[state.regionKey];
  const indices = shuffle(region.seeds.map((_, i) => i)).filter((i) => !state.usedSeeds.has(i));
  let lastErr = null;
  for (let attempt = 0; attempt < Math.min(10, indices.length); attempt++) {
    const seedIdx = indices[attempt];
    const point = jitter(region.seeds[seedIdx], region.jitter);
    try {
      const candidates = shuffle(await searchNear(point));
      for (const c of candidates.slice(0, 3)) {
        try {
          await preloadImage(c.src);
          state.usedSeeds.add(seedIdx);
          state.usedTitles.add(c.title);
          return c;
        } catch { /* try next candidate */ }
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No photos found');
}

/* ---------------- maps ---------------- */
let guessMap, guessMarker, resultMap, resultLayer;

function makePin(kind, label = '') {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}">${label ? `<span class="pin-label">${label}</span>` : ''}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 31],  // tip of the rotated teardrop
  });
}

function initMaps() {
  guessMap = L.map('guessMap', { worldCopyJump: true, zoomControl: true, attributionControl: true, minZoom: 1 });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19 }).addTo(guessMap);
  guessMap.on('click', (e) => placeGuess(e.latlng));

  resultMap = L.map('resultMap', { worldCopyJump: true, zoomControl: false, minZoom: 1 });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19 }).addTo(resultMap);
  L.control.zoom({ position: 'topright' }).addTo(resultMap);
  resultLayer = L.layerGroup().addTo(resultMap);
}

function resetGuessMap() {
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  state.guess = null;
  guessMap.invalidateSize();
  guessMap.fitBounds(REGIONS[state.regionKey].view, { animate: false });
  updateGuessButton();
}

function placeGuess(latlng) {
  if (state.phase !== 'guessing') return;
  state.guess = latlng;
  if (!guessMarker) guessMarker = L.marker(latlng, { icon: makePin('guess'), keyboard: false }).addTo(guessMap);
  else guessMarker.setLatLng(latlng);
  $('guessPanel').classList.add('pinned');
  updateGuessButton();
}

function updateGuessButton() {
  const btn = $('guessBtn');
  btn.disabled = !state.guess;
  btn.textContent = state.guess ? 'Guess' : 'Place a pin on the map';
}

// Shift `to` by ±360° so the line between the two takes the short way round.
function nearCopy(from, to) {
  let lng = to.lng;
  while (lng - from.lng > 180) lng -= 360;
  while (lng - from.lng < -180) lng += 360;
  return L.latLng(to.lat, lng);
}

function animateLine(from, to, done) {
  const line = L.polyline([from, from], { color: '#16243A', weight: 3, dashArray: '2 8', lineCap: 'round' }).addTo(resultLayer);
  if (reduceMotion) { line.setLatLngs([from, to]); done?.(); return; }
  const start = performance.now(), dur = 800;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    line.setLatLngs([from, L.latLng(from.lat + (to.lat - from.lat) * e, from.lng + (to.lng - from.lng) * e)]);
    if (t < 1) requestAnimationFrame(step); else done?.();
  };
  requestAnimationFrame(step);
}

/* ---------------- screens ---------------- */
function showStart() {
  stopTimer();
  state.gameId = (state.gameId || 0) + 1;
  state.prefetch = null;
  state.phase = 'idle';
  $('game').hidden = true;
  $('start').hidden = false;
  renderBest();
  document.querySelector('#setup button[type=submit]').focus({ preventScroll: true });
}

function renderRegions() {
  const wrap = $('regionChips');
  wrap.innerHTML = Object.entries(REGIONS).map(([key, r]) =>
    `<label class="chip"><input type="radio" name="region" value="${key}" ${key === state.regionKey ? 'checked' : ''}><span>${r.label}</span></label>`
  ).join('');
}

function renderBest() {
  const form = $('setup');
  const region = form.region.value, timer = form.timer.value;
  const best = store.get(bestKey(region, timer));
  $('bestLine').innerHTML = best
    ? `Your best in ${REGIONS[region].label}: <strong>${fmt(best)}</strong>`
    : `No score yet in ${REGIONS[region].label}.`;
}

function startGame() {
  const form = $('setup');
  state.regionKey = form.region.value;
  state.timerSecs = Number(form.timer.value);
  state.gameId = (state.gameId || 0) + 1;
  state.round = 0;
  state.total = 0;
  state.results = [];
  state.usedTitles.clear();
  state.usedSeeds.clear();
  state.prefetch = null;

  $('start').hidden = true;
  $('game').hidden = false;
  $('hudTimerWrap').hidden = !state.timerSecs;
  $('hudScore').textContent = '0';
  if (!guessMap) initMaps();
  nextRound();
}

async function nextRound() {
  state.round += 1;
  state.phase = 'loading';
  state.current = null;
  $('hudRound').textContent = `${state.round}/${ROUNDS}`;
  $('result').hidden = true;
  $('guessPanel').classList.remove('pinned', 'open');
  $('stageImg').classList.remove('zoomed');
  showLoading('Finding a place…');
  resetGuessMap();

  const gameId = state.gameId;
  try {
    let loc = state.prefetch ? await state.prefetch : null;
    state.prefetch = null;
    if (!loc) loc = await findLocation();
    if (gameId !== state.gameId) return;   // player left or restarted meanwhile
    state.current = loc;
    $('stageImg').src = loc.src;
    $('stageBlur').style.backgroundImage = `url("${loc.src}")`;
    $('stageCredit').textContent = `Photo: ${loc.artist}${loc.license ? `, ${loc.license}` : ''} — Wikimedia Commons`;
    hideLoading();
    state.phase = 'guessing';
    startTimer();
    // Fetch the next photo while this round is played.
    if (state.round < ROUNDS) state.prefetch = findLocation().catch(() => null);
  } catch (err) {
    if (gameId !== state.gameId) return;
    console.error(err);
    state.round -= 1;
    showLoading("Couldn't load a photo from Wikimedia Commons. Check your connection and try again.", true);
  }
}

function showLoading(text, isError = false) {
  const el = $('loading');
  el.hidden = false;
  el.classList.toggle('error', isError);
  $('loadingText').textContent = text;
  $('retryBtn').hidden = !isError;
}
function hideLoading() { $('loading').hidden = true; }

/* ---------------- timer ---------------- */
function startTimer() {
  stopTimer();
  if (!state.timerSecs) return;
  state.deadline = performance.now() + state.timerSecs * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.deadline - performance.now()) / 1000));
    $('hudTimer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('hudTimerWrap').classList.toggle('urgent', left <= 10);
    if (left <= 0) { stopTimer(); submitGuess(true); }
  };
  tick();
  state.timerId = setInterval(tick, 250);
}
function stopTimer() { clearInterval(state.timerId); state.timerId = null; }

/* ---------------- guessing + result ---------------- */
function submitGuess(timedOut = false) {
  if (state.phase !== 'guessing') return;
  stopTimer();
  state.phase = 'result';
  const loc = state.current;
  const truth = L.latLng(loc.lat, loc.lng);
  const region = REGIONS[state.regionKey];

  let km = null, points = 0, guess = null;
  if (state.guess) {
    guess = state.guess.wrap();
    km = haversine(guess, truth);
    points = scoreFor(km, region.scale);
  }
  state.total += points;
  state.results.push({ loc, guess, km, points });
  $('hudScore').textContent = fmt(state.total);
  $('guessPanel').classList.remove('open');

  showRoundResult({ loc, guess, km, points, timedOut });
}

function showRoundResult({ loc, guess, km, points, timedOut }) {
  $('result').hidden = false;
  resultMap.invalidateSize();
  resultLayer.clearLayers();

  const truth = L.latLng(loc.lat, loc.lng);
  const last = state.round >= ROUNDS;
  const card = $('resultCard');
  const pct = Math.round((points / MAX_POINTS) * 100);

  const placeLine = looksLikeCameraName(loc.name) ? '' : `<p class="r-place">${escapeHTML(loc.name)}</p>`;
  card.innerHTML = `
    <div class="r-top">
      <p class="r-dist">${guess ? `<strong id="rDist">0 km</strong> away` : `<strong>${timedOut ? 'Out of time' : 'No guess'}</strong>`}</p>
      <p class="r-points" id="rPoints">+${fmt(points)}</p>
    </div>
    <div class="r-bar" role="img" aria-label="${pct}% of the maximum"><i id="rBar"></i></div>
    ${placeLine}
    ${loc.desc && loc.desc !== loc.name ? `<p class="r-desc">${escapeHTML(loc.desc)}</p>` : ''}
    <p class="r-credit">Photo by ${escapeHTML(loc.artist)}${loc.license ? `, ${escapeHTML(loc.license)}` : ''}. <a href="${loc.page}" target="_blank" rel="noopener">View on Wikimedia Commons</a></p>
    <div class="r-actions">
      <button class="btn btn-primary" id="nextBtn">${last ? 'See final score' : 'Next round'}</button>
    </div>`;

  const truthMarker = L.marker(truth, { icon: makePin('truth'), keyboard: false }).addTo(resultLayer);
  truthMarker.bindTooltip('Photo location', { direction: 'top', offset: [10, -28] });

  if (guess) {
    const near = nearCopy(truth, guess);
    L.marker(near, { icon: makePin('guess'), keyboard: false }).addTo(resultLayer);
    resultMap.fitBounds(L.latLngBounds([truth, near]), { padding: [60, 60], paddingBottomRight: [60, cardPadding()], maxZoom: 14, animate: false });
    animateLine(near, truth);
    countUp($('rDist'), km);
  } else {
    resultMap.setView(truth, 5, { animate: false });
  }
  requestAnimationFrame(() => { const bar = $('rBar'); if (bar) bar.style.width = `${pct}%`; });

  $('nextBtn').addEventListener('click', () => (last ? showSummary() : nextRound()));
  $('nextBtn').focus({ preventScroll: true });
}

function cardPadding() {
  const card = $('resultCard');
  return (card?.offsetHeight || 220) + 40;
}

function countUp(el, km) {
  if (!el) return;
  if (reduceMotion) { el.textContent = fmtKm(km); return; }
  const start = performance.now(), dur = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = fmtKm(km * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function showSummary() {
  state.phase = 'summary';
  const region = REGIONS[state.regionKey];
  const key = bestKey(state.regionKey, state.timerSecs);
  const prevBest = store.get(key) || 0;
  const isBest = state.total > prevBest;
  if (isBest) store.set(key, state.total);

  resultLayer.clearLayers();
  resultMap.invalidateSize();
  const bounds = [];
  state.results.forEach((r, i) => {
    const truth = L.latLng(r.loc.lat, r.loc.lng);
    L.marker(truth, { icon: makePin('truth', i + 1), keyboard: false }).addTo(resultLayer);
    bounds.push(truth);
    if (r.guess) {
      const near = nearCopy(truth, r.guess);
      L.marker(near, { icon: makePin('guess', i + 1), keyboard: false }).addTo(resultLayer);
      L.polyline([near, truth], { color: '#16243A', weight: 2.5, dashArray: '2 7', lineCap: 'round' }).addTo(resultLayer);
      bounds.push(near);
    }
  });

  const rows = state.results.map((r) => {
    const name = looksLikeCameraName(r.loc.name) ? (r.loc.desc || 'Untitled photo') : r.loc.name;
    return `<li><span class="s-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
      <span class="s-pts">${fmt(r.points)}<span class="s-km">${r.km == null ? 'no guess' : fmtKm(r.km)}</span></span></li>`;
  }).join('');

  $('resultCard').innerHTML = `
    <p class="sum-total">${fmt(state.total)} <span>/ ${fmt(MAX_POINTS * ROUNDS)}</span></p>
    <p class="sum-sub">${region.label}${state.timerSecs ? `, ${state.timerSecs}s per round` : ''}. ${isBest ? (prevBest ? 'New personal best.' : 'Your first score here.') : `Your best here is ${fmt(prevBest)}.`}</p>
    <ol class="sum-list">${rows}</ol>
    <div class="r-actions">
      <button class="btn btn-outline" id="copyBtn">Copy result</button>
      <button class="btn btn-outline" id="menuBtn">Settings</button>
      <button class="btn btn-primary" id="againBtn">Play again</button>
    </div>`;

  resultMap.fitBounds(L.latLngBounds(bounds), { padding: [50, 50], paddingBottomRight: [50, cardPadding()], maxZoom: 8, animate: false });

  $('againBtn').addEventListener('click', startGame);
  $('menuBtn').addEventListener('click', showStart);
  $('copyBtn').addEventListener('click', copyResult);
  $('againBtn').focus({ preventScroll: true });
}

function copyResult() {
  const blocks = state.results.map((r) => (r.points >= 4000 ? '🟩' : r.points >= 2000 ? '🟨' : r.points > 0 ? '🟧' : '⬛')).join('');
  const text = `Onde? ${REGIONS[state.regionKey].label}: ${fmt(state.total)}/${fmt(MAX_POINTS * ROUNDS)}\n${blocks}\n${location.href.split('#')[0]}`;
  const btn = $('copyBtn');
  navigator.clipboard?.writeText(text).then(
    () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy result'), 1800); },
    () => { btn.textContent = 'Copy failed'; }
  );
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- photo zoom ---------------- */
function toggleZoom(e) {
  const img = $('stageImg');
  if (img.classList.contains('zoomed')) { img.classList.remove('zoomed'); return; }
  const r = img.getBoundingClientRect();
  img.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  img.classList.add('zoomed');
}
function panZoom(e) {
  const img = $('stageImg');
  if (!img.classList.contains('zoomed')) return;
  const r = img.getBoundingClientRect();
  img.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
}

/* ---------------- wiring ---------------- */
renderRegions();
$('setup').addEventListener('change', renderBest);
$('setup').addEventListener('submit', (e) => { e.preventDefault(); startGame(); });
$('guessBtn').addEventListener('click', () => submitGuess());
$('retryBtn').addEventListener('click', () => { state.prefetch = null; nextRound(); });
$('quitBtn').addEventListener('click', () => {
  if (state.phase === 'summary' || confirm('Leave this game? Your score so far will be lost.')) showStart();
});
$('stageImg').addEventListener('click', toggleZoom);
$('stageImg').addEventListener('mousemove', panZoom);
$('openMapBtn').addEventListener('click', () => {
  $('guessPanel').classList.add('open');
  setTimeout(() => guessMap.invalidateSize(), 320);
});
$('closeMapBtn').addEventListener('click', () => $('guessPanel').classList.remove('open'));
$('guessPanel').addEventListener('transitionend', () => guessMap?.invalidateSize());

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if ((e.key === ' ' || e.key === 'Enter') && state.phase === 'guessing' && state.guess && !e.target.matches('button')) {
    e.preventDefault(); submitGuess();
  }
});

renderBest();
