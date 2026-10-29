import { REGIONS } from './seeds.js?v=5';

const ROUNDS = 5;
const MAX_POINTS = 5000;

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
function niceTitle(title) {
  return title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').trim();
}
const looksLikeCameraName = (t) => /^(img|dsc|dscf|dscn|pxl|p\d|photo|image|cimg|sam|gopr|dji)[\s_-]?\d/i.test(t) || /^\d[\d\s_-]*$/.test(t);

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
// Each round: pick a seed point in the region, nudge it, ask Wikidata for places
// with a photo nearby (fast, ~0.5 s), then get size + credits for those photos
// from Wikimedia Commons. If that fails, fall back to data/fallback.json.
const SPARQL = 'https://query.wikidata.org/sparql';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';

// File names that usually mean "not a photo of a place".
const BAD_FILE = /\b(map|maps|karte|carte|mapa|plan|lageplan|logo|flag|bandeira|bandera|drapeau|coat of arms|wappen|bras[aã]o|escudo|blason|seal|emblem|diagram|chart|scan|document|signature|stamp|coin|banknote|poster|book|page|letter|manuscript|screenshot|satellite|portrait|painting|museum|exhibit|artefact|artifact|fossil|specimen|herbarium|inscription|plaque|grave|tomb|x-ray|microscop|aerial|a[eé]rea|from the air|from space|view of earth|iss\d+|flight|voo|vuelo|airplane|aircraft window|selfie|location|locator)\b/i;

const commonsPage = (file) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, '_'))}`;
const commonsThumb = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=1280`;

function htmlToText(html, max = 200) {
  if (!html) return '';
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

// Commons sometimes stores the author as just "Self" or "Own work".
const cleanArtist = (a) => (!a || /^(self|own work|unknown|anonymous)$/i.test(a) ? 'a Wikimedia Commons contributor' : a);

// Move a point a random distance (up to maxKm) in a random direction.
function jitter([lat, lng], maxKm) {
  const d = Math.sqrt(Math.random()) * maxKm;
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (d * Math.cos(theta)) / 111;
  const dLng = (d * Math.sin(theta)) / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [Math.max(-85, Math.min(85, lat + dLat)), ((lng + dLng + 540) % 360) - 180];
}

const SEEN_KEY = 'onde.seen';
const seenTitles = () => new Set(store.get(SEEN_KEY) || []);
function rememberSeen(title) {
  const seen = store.get(SEEN_KEY) || [];
  seen.push(title);
  store.set(SEEN_KEY, seen.slice(-500));
}

async function placesNear([lat, lng], radiusKm) {
  const query = `SELECT ?loc ?image ?lbl WHERE {
    SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${lng.toFixed(4)} ${lat.toFixed(4)})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${radiusKm}" . }
    ?item wdt:P18 ?image ; wdt:P17 ?country .          # places belong to a country…
    FILTER NOT EXISTS { ?item wdt:P171 ?taxonParent }    # …and aren't animal or plant species
    OPTIONAL { ?item rdfs:label ?lbl FILTER(lang(?lbl) = "en") }
  } LIMIT 120`;
  const data = await fetchJSON(`${SPARQL}?format=json&query=${encodeURIComponent(query)}`, 8000);
  return (data?.results?.bindings || []).map((b) => {
    const m = b.loc.value.match(/Point\(([-\d.eE]+) ([-\d.eE]+)\)/);
    if (!m) return null;
    return {
      file: decodeURIComponent(b.image.value.split('/').pop()).replace(/_/g, ' '),
      lat: +m[2], lng: +m[1],
      label: b.lbl?.value || '',
    };
  }).filter(Boolean);
}

async function fileInfo(files) {
  const p = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    titles: files.map((f) => 'File:' + f).join('|'),
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280',
    iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription',
  });
  const data = await fetchJSON(`${COMMONS}?${p}`, 8000);
  const byFile = new Map();
  for (const pg of data?.query?.pages || []) if (pg.imageinfo) byFile.set(pg.title.replace(/^File:/, ''), pg.imageinfo[0]);
  // Commons may normalise titles; map those back to what we asked for.
  for (const n of data?.query?.normalized || []) {
    const ii = byFile.get(n.to.replace(/^File:/, ''));
    if (ii) byFile.set(n.from.replace(/^File:/, ''), ii);
  }
  return byFile;
}

const goodSize = (ii) => ii && ii.mime === 'image/jpeg' && ii.width >= 1000 && ii.height >= 600 && ii.width / ii.height >= 0.6 && ii.width / ii.height <= 2.7;

async function findLive() {
  const region = REGIONS[state.regionKey];
  const seen = seenTitles();
  let lastErr = new Error('No photos found');
  for (let attempt = 0; attempt < 6; attempt++) {
    const seed = region.seeds[Math.floor(Math.random() * region.seeds.length)];
    try {
      const places = shuffle(await placesNear(jitter(seed, region.jitter), region.radius))
        .filter((pl) => /\.jpe?g$/i.test(pl.file) && !BAD_FILE.test(pl.file) && !state.usedTitles.has(pl.file));
      const fresh = places.filter((pl) => !seen.has(pl.file));
      const pick = (fresh.length >= 3 ? fresh : places).slice(0, 12);
      if (!pick.length) continue;
      const info = await fileInfo(pick.map((pl) => pl.file));
      let tries = 0;
      for (const pl of pick) {
        const ii = info.get(pl.file);
        if (!goodSize(ii)) continue;
        if (tries++ >= 2) break;
        const src = (ii.thumburl || ii.url).replace(/\?.*$/, '');
        try {
          await preloadImage(src);
          const md = ii.extmetadata || {};
          return {
            title: pl.file,
            name: pl.label || niceTitle(pl.file),
            lat: pl.lat, lng: pl.lng,
            src,
            page: (ii.descriptionurl || commonsPage(pl.file)).replace(/\?.*$/, ''),
            artist: cleanArtist(htmlToText(md.Artist?.value, 80)),
            license: htmlToText(md.LicenseShortName?.value, 40),
            desc: htmlToText(md.ImageDescription?.value),
          };
        } catch { /* image failed — try the next one */ }
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

let fallbackPromise = null;
async function findFallback() {
  fallbackPromise ||= fetchJSON('data/fallback.json', 10000).catch((e) => { fallbackPromise = null; throw e; });
  const pool = await fallbackPromise;
  const list = state.regionKey === 'world' ? Object.values(pool).flat() : (pool[state.regionKey] || []);
  const seen = seenTitles();
  const avail = list.filter((e) => !state.usedTitles.has(e.t));
  const fresh = avail.filter((e) => !seen.has(e.t));
  for (const e of shuffle(fresh.length ? fresh : avail).slice(0, 4)) {
    const src = commonsThumb(e.t);
    try {
      await preloadImage(src);
      return { title: e.t, name: e.n || niceTitle(e.t), lat: e.la, lng: e.lo, src, page: commonsPage(e.t), artist: cleanArtist(e.a), license: e.l || '', desc: '' };
    } catch { /* next */ }
  }
  throw new Error('Photos failed to load');
}

async function findLocation() {
  let loc;
  try { loc = await findLive(); } catch (e) { console.warn('Live search failed, using built-in photos:', e); loc = await findFallback(); }
  state.usedTitles.add(loc.title);
  rememberSeen(loc.title);
  return loc;
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
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(guessMap);
  guessMap.on('click', (e) => placeGuess(e.latlng));

  resultMap = L.map('resultMap', { worldCopyJump: true, zoomControl: false, minZoom: 1 });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(resultMap);
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
