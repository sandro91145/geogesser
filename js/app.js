import { REGIONS } from './seeds.js?v=9';
import { StreetViewer, findPano, panoFromSpec, panoSpec, panoramaxCandidates, preloadPano, hasMapillary } from './street.js?v=9';
import { hasLeaderboard, topScores, rankOf, submitScore, savedName, submittedToday } from './leaderboard.js?v=9';

const ROUNDS = 5;
const MAX_POINTS = 5000;

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  regionKey: 'world',
  game: 'classic',       // classic | streak
  mode: 'street',        // street | photo
  streak: 0,
  guessCountry: null,    // Promise<{cc,name,flag}|null|undefined> for the current pin (streak)
  move: 'move',          // move | nomove | nmpz
  timerSecs: 0,
  kind: 'custom',        // custom | daily | challenge
  dailyDate: null,
  challenge: null,       // decoded challenge payload
  round: 0,
  total: 0,
  results: [],           // { loc, guess, km, points }
  current: null,
  guess: null,
  usedTitles: new Set(),
  prefetch: null,
  timerId: null,
  deadline: 0,
  phase: 'idle',         // idle | loading | guessing | result | summary
  gameId: 0,
};

/* ---------------- storage ---------------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const bestKey = () => `onde.best.${state.game === 'streak' ? 'streak.' : ''}${state.mode}.${state.regionKey}.${state.timerSecs}${state.mode === 'street' ? '.' + state.move : ''}`;

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
const shuffle = (arr, rnd = Math.random) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const niceTitle = (t) => t.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').trim();
const looksLikeCameraName = (t) => /^(img|dsc|dscf|dscn|pxl|p\d|photo|image|cimg|sam|gopr|dji)[\s_-]?\d/i.test(t) || /^\d[\d\s_-]*$/.test(t);
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Seeded random numbers, so the daily challenge is the same for everyone.
function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) { h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const todayUTC = () => new Date().toISOString().slice(0, 10);
const prettyDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

// Challenge links: rounds + settings packed into the URL hash.
const b64url = {
  encode: (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))),
};

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

const SEEN_KEY = 'onde.seen';
const seenTitles = () => new Set(store.get(SEEN_KEY) || []);
function rememberSeen(id) {
  const seen = store.get(SEEN_KEY) || [];
  seen.push(id);
  store.set(SEEN_KEY, seen.slice(-500));
}

/* ---------------- photo mode (Wikidata + Commons) ---------------- */
const SPARQL = 'https://query.wikidata.org/sparql';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const BAD_FILE = /\b(map|maps|karte|carte|mapa|plan|lageplan|logo|flag|bandeira|bandera|drapeau|coat of arms|wappen|bras[aã]o|escudo|blason|seal|emblem|diagram|chart|scan|document|signature|stamp|coin|banknote|poster|book|page|letter|manuscript|screenshot|satellite|portrait|painting|museum|exhibit|artefact|artifact|fossil|specimen|herbarium|inscription|plaque|grave|tomb|x-ray|microscop|aerial|a[eé]rea|from the air|from space|view of earth|iss\d+|flight|voo|vuelo|airplane|aircraft window|selfie|location|locator)\b/i;
const commonsPage = (file) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, '_'))}`;
const commonsThumb = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=1280`;

function htmlToText(html, max = 200) {
  if (!html) return '';
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
const cleanArtist = (a) => (!a || /^(self|own work|unknown|anonymous)$/i.test(a) ? 'a Wikimedia Commons contributor' : a);

function jitter([lat, lng], maxKm) {
  const d = Math.sqrt(Math.random()) * maxKm;
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (d * Math.cos(theta)) / 111;
  const dLng = (d * Math.sin(theta)) / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [Math.max(-85, Math.min(85, lat + dLat)), ((lng + dLng + 540) % 360) - 180];
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
    return { file: decodeURIComponent(b.image.value.split('/').pop()).replace(/_/g, ' '), lat: +m[2], lng: +m[1], label: b.lbl?.value || '' };
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
  for (const n of data?.query?.normalized || []) {
    const ii = byFile.get(n.to.replace(/^File:/, ''));
    if (ii) byFile.set(n.from.replace(/^File:/, ''), ii);
  }
  return byFile;
}
const goodSize = (ii) => ii && ii.mime === 'image/jpeg' && ii.width >= 1000 && ii.height >= 600 && ii.width / ii.height >= 0.6 && ii.width / ii.height <= 2.7;

function photoLoc(pl, ii) {
  const md = ii.extmetadata || {};
  return {
    kind: 'photo', id: pl.file, title: pl.file,
    name: pl.label || niceTitle(pl.file),
    lat: pl.lat, lng: pl.lng,
    src: (ii.thumburl || ii.url).replace(/\?.*$/, ''),
    page: (ii.descriptionurl || commonsPage(pl.file)).replace(/\?.*$/, ''),
    author: cleanArtist(htmlToText(md.Artist?.value, 80)),
    license: htmlToText(md.LicenseShortName?.value, 40),
    desc: htmlToText(md.ImageDescription?.value),
  };
}

async function findPhoto() {
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
        const loc = photoLoc(pl, ii);
        try { await preloadImage(loc.src); return loc; } catch { /* next */ }
      }
    } catch (e) { lastErr = e; }
  }
  // Wikidata unreachable: use the built-in photos.
  try { return await findFallbackPhoto(); } catch { throw lastErr; }
}

let fallbackPromise = null;
async function findFallbackPhoto() {
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
      return { kind: 'photo', id: e.t, title: e.t, name: e.n || niceTitle(e.t), lat: e.la, lng: e.lo, src, page: commonsPage(e.t), author: cleanArtist(e.a), license: e.l || '', desc: '' };
    } catch { /* next */ }
  }
  throw new Error('Photos failed to load');
}

async function photoFromSpec([, title, lat, lng, label]) {
  const ii = (await fileInfo([title])).get(title);
  if (!ii) throw new Error('Photo not found');
  const loc = photoLoc({ file: title, lat, lng, label }, ii);
  await preloadImage(loc.src);
  return loc;
}

/* ---------------- locations: specs, daily, finding ---------------- */
const specOf = (loc) => (loc.kind === 'pano' ? panoSpec(loc) : ['w', loc.title, +loc.lat.toFixed(5), +loc.lng.toFixed(5), loc.name === niceTitle(loc.title) ? '' : loc.name]);

async function locFromSpec(spec) {
  if (spec[0] === 'w') return photoFromSpec(spec);
  const pano = await panoFromSpec(spec);
  await preloadPano(pano.src);
  return pano;
}

// Daily: each round draws from a random generator seeded with the date and round
// number, over the same Panoramax coverage and the same sorted search results.
async function dailyLocation(i) {
  const rnd = seededRandom(`onde-daily-${state.dailyDate}-${i}`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const list = (await panoramaxCandidates(REGIONS.world, rnd)).filter((f) => !state.usedTitles.has(f.id));
    if (!list.length) continue;
    const f = list[Math.floor(rnd() * list.length)];
    return locFromSpec(['x', f.id]);
  }
  throw new Error('Daily challenge unavailable');
}

async function findLocation(roundNo) {
  let loc;
  if (state.kind === 'challenge') loc = await locFromSpec(state.challenge.s[roundNo - 1]);
  else if (state.kind === 'daily') loc = await dailyLocation(roundNo);
  else if (state.mode === 'street') loc = await findPano(REGIONS[state.regionKey], state.usedTitles);
  else loc = await findPhoto();
  state.usedTitles.add(String(loc.id));
  if (state.kind === 'custom') rememberSeen(String(loc.id));
  return loc;
}

const flagOf = (cc) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1F1A5 + c.charCodeAt(0))) : '');
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=en';

// Town/region + country for the result card (only fetched after the guess,
// or in the background during a streak round, where the country is needed).
function placeName(loc) {
  loc.placePromise ||= fetchJSON(`${NOMINATIM}&zoom=10&lat=${loc.lat}&lon=${loc.lng}`, 6000).then((d) => {
    const a = d.address || {};
    const local = a.city || a.town || a.village || a.municipality || a.county || a.state_district || a.state || '';
    loc.cc = (a.country_code || '').toUpperCase();
    loc.country = a.country || '';
    loc.flag = flagOf(loc.cc);
    loc.place = [local, a.country].filter(Boolean).join(', ');
    return loc.place;
  }).catch(() => { loc.placePromise = null; loc.place = ''; return ''; });
  return loc.placePromise;
}

// Which country is a map click in? null = sea / no country, undefined = lookup failed.
const countryCache = new Map();
function countryAt(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (!countryCache.has(key)) {
    countryCache.set(key, fetchJSON(`${NOMINATIM}&zoom=3&lat=${lat}&lon=${lng}`, 6000).then((d) => {
      const cc = (d.address?.country_code || '').toUpperCase();
      return cc ? { cc, name: d.address.country, flag: flagOf(cc) } : null;
    }).catch(() => { countryCache.delete(key); return undefined; }));
  }
  return countryCache.get(key);
}

/* ---------------- maps ---------------- */
let guessMap, guessMarker, resultMap, resultLayer;

function makePin(kind, label = '') {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}">${label ? `<span class="pin-label">${label}</span>` : ''}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 31],
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
  state.guessCountry = null;
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
  if (state.game === 'streak') {
    // Wait until the player stops clicking around before asking which country it is.
    const w = latlng.wrap();
    clearTimeout(placeGuess.timer);
    const p = (state.guessCountry = new Promise((res) => { placeGuess.timer = setTimeout(() => countryAt(w.lat, w.lng).then(res), 400); }));
    updateGuessButton();
    p.then(() => { if (state.guessCountry === p) updateGuessButton(); });
  } else updateGuessButton();
}

async function updateGuessButton() {
  const btn = $('guessBtn');
  if (state.game !== 'streak' || !state.guess) {
    btn.disabled = !state.guess;
    btn.textContent = state.guess ? 'Guess' : state.game === 'streak' ? 'Click the country you think it is' : 'Place a pin on the map';
    return;
  }
  const p = state.guessCountry;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const c = await p;
  if (state.guessCountry !== p) return;
  if (c) { btn.disabled = false; btn.textContent = `Guess ${c.flag} ${c.name}`; }
  else if (c === null) btn.textContent = "That's not a country. Click on land";
  else { btn.disabled = false; btn.textContent = 'Guess'; }
}

function nearCopy(from, to) {
  let lng = to.lng;
  while (lng - from.lng > 180) lng -= 360;
  while (lng - from.lng < -180) lng += 360;
  return L.latLng(to.lat, lng);
}

function animateLine(from, to) {
  const line = L.polyline([from, from], { color: '#16243A', weight: 3, dashArray: '2 8', lineCap: 'round' }).addTo(resultLayer);
  if (reduceMotion) { line.setLatLngs([from, to]); return; }
  const start = performance.now(), dur = 800;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    line.setLatLngs([from, L.latLng(from.lat + (to.lat - from.lat) * e, from.lng + (to.lng - from.lng) * e)]);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------------- street viewer ---------------- */
let viewer = null;
function getViewer() {
  viewer ||= new StreetViewer($('pano'), {
    onHeading: (deg) => { $('compassRose').style.transform = `rotate(${-deg}deg)`; },
  });
  return viewer;
}

/* ---------------- start screen ---------------- */
function renderRegions() {
  $('regionChips').innerHTML = Object.entries(REGIONS).map(([key, r]) =>
    `<label class="chip"><input type="radio" name="region" value="${key}" ${key === state.regionKey ? 'checked' : ''}><span>${r.label}</span></label>`
  ).join('');
}

function readForm() {
  const form = $('setup');
  state.game = form.game.value;
  state.mode = form.mode.value;
  state.regionKey = form.region.value;
  state.move = form.move.value;
  state.timerSecs = Number(form.timer.value);
}

function renderSetup() {
  readForm();
  $('moveField').hidden = state.mode !== 'street';
  const best = store.get(bestKey());
  const where = REGIONS[state.regionKey].label;
  $('bestLine').innerHTML = state.game === 'streak'
    ? (best ? `Your best streak with these settings: <strong>${best}</strong>` : `No streak yet for ${where} with these settings.`)
    : (best ? `Your best with these settings: <strong>${fmt(best)}</strong>` : `No score yet for ${where} with these settings.`);
}

/* ---------------- daily leaderboard ---------------- */
async function renderBoard(el, day, { limit = 10, highlight = null } = {}) {
  if (!el || !hasLeaderboard()) return;
  el.innerHTML = '<p class="lb-note">Loading today\'s scores…</p>';
  try {
    const rows = await topScores(day, limit);
    if (!rows.length) { el.innerHTML = '<p class="lb-note">No scores yet today. Be the first.</p>'; return; }
    const mine = highlight || submittedToday(day);
    let marked = false;
    el.innerHTML = `<ol class="lb-list">${rows.map((r, i) => {
      const me = !marked && mine && r.name === mine.name && r.score === mine.score && (marked = true);
      return `<li class="${me ? 'me' : ''}"><span class="lb-rank">${i + 1}</span><span class="lb-name">${escapeHTML(r.name)}${me ? ' <em>(you)</em>' : ''}</span><span class="lb-blocks" aria-hidden="true">${blocks(r.points || [])}</span><span class="lb-score">${fmt(r.score)}</span></li>`;
    }).join('')}</ol>`;
    if (mine && !marked) {
      const { rank, total } = await rankOf(day, mine.score);
      el.insertAdjacentHTML('beforeend', `<p class="lb-note">You're #${rank} of ${total} today with ${fmt(mine.score)}.</p>`);
    }
  } catch {
    el.innerHTML = '<p class="lb-note">The leaderboard is unavailable right now.</p>';
  }
}

// Name form for adding today's official score. `onDone` runs after saving.
function renderSubmit(el, entry, onDone) {
  if (!el || !hasLeaderboard()) return;
  if (submittedToday(entry.date)) { onDone?.(); return; }
  el.innerHTML = `
    <form class="lb-form" id="lbForm">
      <label for="lbName">Add your score to today's leaderboard</label>
      <div class="lb-row">
        <input id="lbName" name="name" maxlength="20" autocomplete="nickname" placeholder="Your name" value="${escapeHTML(savedName())}" required>
        <button class="btn btn-primary" type="submit" id="lbSubmit">Add score</button>
      </div>
      <p class="lb-msg" id="lbMsg" role="status"></p>
    </form>`;
  $('lbForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('lbSubmit'), msg = $('lbMsg');
    btn.disabled = true; btn.textContent = 'Adding…'; msg.textContent = '';
    try {
      const res = await submitScore({ day: entry.date, name: $('lbName').value, score: entry.total, points: entry.points });
      el.innerHTML = `<p class="lb-note">${res === 'duplicate' ? 'Your score for today was already on the leaderboard.' : 'Added. Here\'s how you compare:'}</p>`;
      onDone?.();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Add score';
      msg.textContent = err.message === 'Enter a name' ? 'Enter a name first.' : "Couldn't add your score. Check your connection and try again.";
    }
  });
}

function renderDaily() {
  const date = todayUTC();
  const done = store.get(`onde.daily.${date}`);
  $('dailyTitle').textContent = `Daily challenge · ${prettyDate(date)}`;
  if (done) {
    $('dailyLine').innerHTML = `You scored <strong>${fmt(done.total)}</strong> today. New places tomorrow.`;
    $('dailyActions').innerHTML = `
      <button type="button" class="btn btn-outline" id="dailyCopy">Copy result</button>
      <button type="button" class="btn btn-outline" id="dailyAgain">Play again for fun</button>`;
    $('dailyCopy').addEventListener('click', (e) => copyText(dailyShareText(done), e.currentTarget, 'Copy result'));
    $('dailyAgain').addEventListener('click', () => startDaily());
  } else {
    $('dailyLine').textContent = 'The same five street views for everyone today, anywhere in the world.';
    $('dailyActions').innerHTML = `<button type="button" class="btn btn-primary" id="dailyBtn">Play today's challenge</button>`;
    $('dailyBtn').addEventListener('click', () => startDaily());
  }
  const box = $('dailyBoard');
  box.hidden = !hasLeaderboard();
  if (!hasLeaderboard()) return;
  box.innerHTML = '<h3>Today\'s top scores</h3><div id="dailySubmit"></div><div id="dailyList"></div>';
  const list = () => renderBoard($('dailyList'), date, { limit: 5 });
  if (done && done.points) renderSubmit($('dailySubmit'), done, list); else list();
}

function renderChallenge() {
  const c = state.challenge;
  $('challenge').hidden = !c;
  if (!c) return;
  const mode = c.m === 'street' ? `street view${c.mv === 'move' ? '' : c.mv === 'nomove' ? ', no moving' : ', no moving, panning or zooming'}` : 'photos';
  $('challengeLine').textContent = `${REGIONS[c.r]?.label || 'World'}, ${mode}${c.t ? `, ${c.t}s per round` : ''}. ${c.p ? `Their score: ${fmt(c.p)}.` : ''}`;
}

function showStart() {
  stopTimer();
  state.gameId++;
  state.prefetch = null;
  state.phase = 'idle';
  $('game').hidden = true;
  $('start').hidden = false;
  renderDaily();
  renderChallenge();
  renderSetup();
}

/* ---------------- game flow ---------------- */
function beginGame() {
  state.gameId++;
  state.round = 0;
  state.total = 0;
  state.streak = 0;
  state.results = [];
  state.usedTitles.clear();
  state.prefetch = null;
  $('start').hidden = true;
  $('hudScoreWrap').hidden = state.game === 'streak';
  $('game').hidden = false;
  $('hudTimerWrap').hidden = !state.timerSecs;
  $('hudScore').textContent = '0';
  $('hudRoundLabel').textContent = state.game === 'streak' ? 'Streak' : state.kind === 'daily' ? 'Daily' : state.kind === 'challenge' ? 'Challenge' : 'Round';
  if (!guessMap) initMaps();
  nextRound();
}

function startCustom() { readForm(); state.kind = 'custom'; beginGame(); }

function startDaily() {
  state.kind = 'daily';
  state.game = 'classic';
  state.dailyDate = todayUTC();
  state.mode = 'street';
  state.regionKey = 'world';
  state.move = 'move';
  state.timerSecs = 0;
  beginGame();
}

function startChallenge() {
  const c = state.challenge;
  state.kind = 'challenge';
  state.game = 'classic';
  state.mode = c.m;
  state.regionKey = REGIONS[c.r] ? c.r : 'world';
  state.move = c.mv || 'move';
  state.timerSecs = c.t || 0;
  beginGame();
}

async function nextRound() {
  state.round += 1;
  state.phase = 'loading';
  state.current = null;
  $('hudRound').textContent = state.game === 'streak' ? String(state.streak) : `${state.round}/${ROUNDS}`;
  $('result').hidden = true;
  $('guessPanel').classList.remove('pinned', 'open');
  $('stageImg').classList.remove('zoomed');
  showLoading('Finding a place…');
  resetGuessMap();

  const gameId = state.gameId, roundNo = state.round;
  try {
    let loc = state.prefetch ? await state.prefetch : null;
    state.prefetch = null;
    if (!loc) loc = await findLocation(roundNo);
    if (gameId !== state.gameId) return;
    state.current = loc;
    await showLocation(loc);
    if (gameId !== state.gameId) return;
    hideLoading();
    state.phase = 'guessing';
    startTimer();
    if (state.game === 'streak') placeName(loc);   // know the country before the guess
    if (state.game === 'streak' || roundNo < ROUNDS) state.prefetch = findLocation(roundNo + 1).catch(() => null);
  } catch (err) {
    if (gameId !== state.gameId) return;
    console.error(err);
    state.round -= 1;
    const street = state.mode === 'street';
    showLoading(street
      ? "Couldn't load a street view. The imagery servers may be busy. Try again, or switch to photos."
      : "Couldn't load a photo from Wikimedia Commons. Check your connection and try again.", true, street && state.kind === 'custom');
  }
}

async function showLocation(loc) {
  const isPano = loc.kind === 'pano';
  $('stageImg').hidden = isPano;
  $('stageBlur').hidden = isPano;
  $('pano').hidden = !isPano;
  $('compass').hidden = !isPano;
  $('stageTools').hidden = !(isPano && state.move === 'move');
  if (isPano) {
    const v = getViewer();
    v.setMode(state.move);
    await v.show(loc, { first: true });
    v.setMode(state.move);
    $('stageCredit').textContent = `Imagery: ${loc.source === 'mapillary' ? 'Mapillary' : 'Panoramax'} contributors`;
    $('stageHint').textContent = state.move === 'nmpz' ? 'No moving, panning or zooming' : state.move === 'move' ? 'Drag to look around · click the arrows or press ↑ to walk' : 'Drag to look around';
  } else {
    $('stageImg').src = loc.src;
    $('stageBlur').style.backgroundImage = `url("${loc.src}")`;
    $('stageCredit').textContent = 'Photo: Wikimedia Commons';
    $('stageHint').textContent = 'Click the photo to zoom';
  }
  $('stageHint').hidden = state.round > 1;
}

function showLoading(text, isError = false, offerSwitch = false) {
  const el = $('loading');
  el.hidden = false;
  el.classList.toggle('error', isError);
  $('loadingText').textContent = text;
  $('retryBtn').hidden = !isError;
  $('switchBtn').hidden = !offerSwitch;
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
  if (state.game === 'streak') return submitStreakGuess(timedOut);
  stopTimer();
  state.phase = 'result';
  const loc = state.current;
  const truth = L.latLng(loc.lat, loc.lng);
  let km = null, points = 0, guess = null;
  if (state.guess) {
    guess = state.guess.wrap();
    km = haversine(guess, truth);
    points = scoreFor(km, REGIONS[state.regionKey].scale);
  }
  state.total += points;
  state.results.push({ loc, guess, km, points });
  $('hudScore').textContent = fmt(state.total);
  $('guessPanel').classList.remove('open');
  showRoundResult({ loc, guess, km, points, timedOut });
}

const sourceName = (loc) => (loc.kind === 'photo' ? 'Wikimedia Commons' : loc.source === 'mapillary' ? 'Mapillary' : 'Panoramax');

function showRoundResult({ loc, guess, km, points, timedOut }) {
  $('result').hidden = false;
  resultMap.invalidateSize();
  resultLayer.clearLayers();

  const truth = L.latLng(loc.lat, loc.lng);
  const last = state.round >= ROUNDS;
  const pct = Math.round((points / MAX_POINTS) * 100);
  const title = loc.kind === 'photo' && !looksLikeCameraName(loc.name) ? `<p class="r-place">${escapeHTML(loc.name)}</p>` : '';

  $('resultCard').innerHTML = `
    <div class="r-top">
      <p class="r-dist">${guess ? `<strong id="rDist">0 km</strong> away` : `<strong>${timedOut ? 'Out of time' : 'No guess'}</strong>`}</p>
      <p class="r-points" id="rPoints">+${fmt(points)}</p>
    </div>
    <div class="r-bar" role="img" aria-label="${pct}% of the maximum"><i id="rBar"></i></div>
    ${title}
    <p class="r-where" id="rWhere"></p>
    ${loc.desc && loc.desc !== loc.name ? `<p class="r-desc">${escapeHTML(loc.desc)}</p>` : ''}
    <p class="r-credit">${loc.kind === 'photo' ? 'Photo' : 'Imagery'} by ${escapeHTML(loc.author)}${loc.license ? `, ${escapeHTML(loc.license)}` : ''}. <a href="${loc.page}" target="_blank" rel="noopener">View on ${sourceName(loc)}</a></p>
    <div class="r-actions">
      <button class="btn btn-primary" id="nextBtn">${last ? 'See final score' : 'Next round'}</button>
    </div>`;

  placeName(loc).then((place) => {
    const el = $('rWhere');
    if (el && place) el.textContent = `${loc.flag ? loc.flag + ' ' : ''}${place}`;
  });

  L.marker(truth, { icon: makePin('truth'), keyboard: false }).addTo(resultLayer)
    .bindTooltip(loc.kind === 'pano' ? 'Where you were' : 'Photo location', { direction: 'top', offset: [10, -28] });

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

const cardPadding = () => ($('resultCard')?.offsetHeight || 220) + 40;

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

const blocks = (pts) => pts.map((p) => (p >= 4000 ? '🟩' : p >= 2000 ? '🟨' : p > 0 ? '🟧' : '⬛')).join('');
const baseUrl = () => location.href.split('#')[0].split('?')[0];
const dailyShareText = (d) => `Onde? Daily ${prettyDate(d.date)}: ${fmt(d.total)}/${fmt(MAX_POINTS * ROUNDS)}\n${blocks(d.points)}\n${baseUrl()}`;

function challengeLink() {
  const payload = { v: 1, m: state.mode, r: state.regionKey, mv: state.move, t: state.timerSecs, p: state.total, s: state.results.map((r) => specOf(r.loc)) };
  return `${baseUrl()}#c=${b64url.encode(payload)}`;
}

function showSummary() {
  state.phase = 'summary';
  const region = REGIONS[state.regionKey];
  const points = state.results.map((r) => r.points);
  let sub;

  if (state.kind === 'daily') {
    const key = `onde.daily.${state.dailyDate}`;
    const first = !store.get(key);
    if (first) store.set(key, { date: state.dailyDate, total: state.total, points });
    sub = first ? `Daily challenge, ${prettyDate(state.dailyDate)}. Come back tomorrow for five new places.` : `Practice run. Your official score today is ${fmt(store.get(key).total)}.`;
  } else if (state.kind === 'challenge') {
    const theirs = state.challenge.p;
    sub = theirs ? (state.total > theirs ? `You beat your friend's ${fmt(theirs)}.` : state.total === theirs ? `A tie with your friend's ${fmt(theirs)}.` : `Your friend scored ${fmt(theirs)}.`) : 'Challenge complete.';
  } else {
    const key = bestKey();
    const prevBest = store.get(key) || 0;
    const isBest = state.total > prevBest;
    if (isBest) store.set(key, state.total);
    const what = state.mode === 'street' ? 'street view' : 'photos';
    sub = `${region.label}, ${what}${state.timerSecs ? `, ${state.timerSecs}s per round` : ''}. ${isBest ? (prevBest ? 'New personal best.' : 'Your first score with these settings.') : `Your best is ${fmt(prevBest)}.`}`;
  }

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

  const rowName = (r) => {
    if (r.loc.kind === 'photo' && !looksLikeCameraName(r.loc.name)) return r.loc.name;
    return r.loc.place ? `${r.loc.flag ? r.loc.flag + ' ' : ''}${r.loc.place}` : 'Somewhere';
  };
  const rows = state.results.map((r, i) => `<li><span class="s-name" id="sName${i}" title="${escapeHTML(rowName(r))}">${escapeHTML(rowName(r))}</span>
      <span class="s-pts">${fmt(r.points)}<span class="s-km">${r.km == null ? 'no guess' : fmtKm(r.km)}</span></span></li>`).join('');

  $('resultCard').innerHTML = `
    <p class="sum-total">${fmt(state.total)} <span>/ ${fmt(MAX_POINTS * ROUNDS)}</span></p>
    <p class="sum-sub">${escapeHTML(sub)}</p>
    <ol class="sum-list">${rows}</ol>
    ${state.kind === 'daily' && hasLeaderboard() ? '<section class="lb" aria-label="Today\'s leaderboard"><div id="sumSubmit"></div><div id="sumBoard"></div></section>' : ''}
    <div class="r-actions">
      <button class="btn btn-outline" id="copyBtn">Copy result</button>
      <button class="btn btn-outline" id="linkBtn">Challenge a friend</button>
      <button class="btn btn-outline" id="menuBtn">Menu</button>
      ${state.kind === 'custom' ? '<button class="btn btn-primary" id="againBtn">Play again</button>' : ''}
    </div>`;

  // Fill in any place names that weren't looked up yet.
  state.results.forEach((r, i) => {
    if (r.loc.place === undefined && r.loc.kind === 'pano') placeName(r.loc).then(() => { const el = $(`sName${i}`); if (el) el.textContent = rowName(r); });
  });

  resultMap.fitBounds(L.latLngBounds(bounds), { padding: [50, 50], paddingBottomRight: [50, cardPadding()], maxZoom: 8, animate: false });

  $('againBtn')?.addEventListener('click', startCustom);
  $('menuBtn').addEventListener('click', () => { history.replaceState(null, '', baseUrl()); showStart(); });
  $('linkBtn').addEventListener('click', (e) => copyText(`Can you beat ${fmt(state.total)} on Onde?\n${challengeLink()}`, e.currentTarget, 'Challenge a friend', 'Link copied'));
  $('copyBtn').addEventListener('click', (e) => {
    const text = state.kind === 'daily'
      ? dailyShareText({ date: state.dailyDate, total: state.total, points })
      : `Onde? ${region.label}: ${fmt(state.total)}/${fmt(MAX_POINTS * ROUNDS)}\n${blocks(points)}\n${baseUrl()}`;
    copyText(text, e.currentTarget, 'Copy result');
  });
  ($('againBtn') || $('linkBtn')).focus({ preventScroll: true });

  if (state.kind === 'daily' && hasLeaderboard()) {
    const official = store.get(`onde.daily.${state.dailyDate}`);
    const board = () => renderBoard($('sumBoard'), state.dailyDate);
    if (official && official.total === state.total && !submittedToday(state.dailyDate)) {
      renderSubmit($('sumSubmit'), official, board);
      $('lbName')?.focus({ preventScroll: true });
    } else board();
  }
}

/* ---------------- country streak ---------------- */
async function submitStreakGuess(timedOut) {
  const loc = state.current;
  let guessed = null;
  if (state.guess) {
    const w = state.guess.wrap();
    guessed = await (state.guessCountry || countryAt(w.lat, w.lng));
    if (!timedOut && !guessed) { updateGuessButton(); return; }  // sea, or the lookup failed: let them try again
  }
  if (state.phase !== 'guessing') return;
  stopTimer();
  state.phase = 'result';
  $('guessBtn').disabled = true;
  await placeName(loc);
  const truth = loc.cc ? { cc: loc.cc, name: loc.country, flag: loc.flag } : null;
  const correct = !!(guessed && truth && guessed.cc === truth.cc);
  const unknown = !truth;            // couldn't tell which country it was: doesn't count
  if (correct) state.streak++;
  const truthLL = L.latLng(loc.lat, loc.lng);
  const guessLL = state.guess ? state.guess.wrap() : null;
  const km = guessLL ? haversine(guessLL, truthLL) : null;
  state.results.push({ loc, guess: guessLL, km, points: 0, correct, guessed, truth });
  $('hudRound').textContent = String(state.streak);
  $('guessPanel').classList.remove('open');
  showStreakResult({ loc, guessLL, km, correct, unknown, guessed, truth, timedOut });
}

function showStreakResult({ loc, guessLL, km, correct, unknown, guessed, truth, timedOut }) {
  $('result').hidden = false;
  resultMap.invalidateSize();
  resultLayer.clearLayers();
  const over = !correct && !unknown;
  const verdict = unknown ? "Couldn't check this one" : correct ? 'Correct' : timedOut && !guessed ? 'Out of time' : 'Wrong country';
  const detail = unknown
    ? "We couldn't tell which country this was, so it doesn't count either way."
    : correct ? `It was ${truth.flag} ${escapeHTML(truth.name)}. Streak: ${state.streak}.`
      : `It was ${truth.flag} ${escapeHTML(truth.name)}${guessed ? `, not ${guessed.flag} ${escapeHTML(guessed.name)}` : ''}.`;
  $('resultCard').innerHTML = `
    <p class="streak-verdict ${correct ? 'ok' : unknown ? '' : 'bad'}">${verdict}</p>
    <p class="streak-detail">${detail}</p>
    <p class="r-where">${loc.place ? escapeHTML(loc.place) : ''}${km != null ? ` <span class="r-km">· your pin was ${fmtKm(km)} away</span>` : ''}</p>
    <p class="r-credit">Imagery by ${escapeHTML(loc.author)}${loc.license ? `, ${escapeHTML(loc.license)}` : ''}. <a href="${loc.page}" target="_blank" rel="noopener">View on ${sourceName(loc)}</a></p>
    <div class="r-actions">
      <button class="btn btn-primary" id="nextBtn">${over ? 'See results' : 'Next country'}</button>
    </div>`;
  L.marker(L.latLng(loc.lat, loc.lng), { icon: makePin('truth'), keyboard: false }).addTo(resultLayer);
  if (guessLL) {
    const near = nearCopy(L.latLng(loc.lat, loc.lng), guessLL);
    L.marker(near, { icon: makePin('guess'), keyboard: false }).addTo(resultLayer);
    resultMap.fitBounds(L.latLngBounds([L.latLng(loc.lat, loc.lng), near]), { padding: [60, 60], paddingBottomRight: [60, cardPadding()], maxZoom: 7, animate: false });
    animateLine(near, L.latLng(loc.lat, loc.lng));
  } else resultMap.setView([loc.lat, loc.lng], 5, { animate: false });
  $('nextBtn').addEventListener('click', () => (over ? showStreakSummary() : nextRound()));
  $('nextBtn').focus({ preventScroll: true });
}

function showStreakSummary() {
  state.phase = 'summary';
  const key = bestKey();
  const prevBest = store.get(key) || 0;
  const isBest = state.streak > prevBest;
  if (isBest) store.set(key, state.streak);
  resultLayer.clearLayers();
  resultMap.invalidateSize();
  const bounds = [];
  state.results.forEach((r, i) => {
    const ll = L.latLng(r.loc.lat, r.loc.lng);
    L.marker(ll, { icon: makePin(r.correct ? 'truth' : 'guess', i + 1), keyboard: false }).addTo(resultLayer);
    bounds.push(ll);
  });
  const flags = state.results.filter((r) => r.correct).map((r) => r.truth.flag).join('');
  const last = state.results[state.results.length - 1];
  const sub = `${REGIONS[state.regionKey].label}. ${isBest ? (prevBest ? 'New best streak.' : 'Your first streak with these settings.') : `Your best is ${prevBest}.`}`;
  const rows = state.results.map((r) => `<li><span class="s-name">${r.truth ? `${r.truth.flag} ${escapeHTML(r.truth.name)}` : 'Unknown'}</span>
      <span class="s-pts">${r.correct ? '✓' : r.truth ? '✗' : '–'}<span class="s-km">${r.guessed ? `${r.guessed.flag} ${escapeHTML(r.guessed.name)}` : 'no guess'}</span></span></li>`).join('');
  $('resultCard').innerHTML = `
    <p class="sum-total">${state.streak} <span>${state.streak === 1 ? 'country' : 'countries'} in a row</span></p>
    <p class="sum-sub">${escapeHTML(sub)}${last?.truth ? ` The last one was ${last.truth.flag} ${escapeHTML(last.truth.name)}.` : ''}</p>
    <ol class="sum-list">${rows}</ol>
    <div class="r-actions">
      <button class="btn btn-outline" id="copyBtn">Copy result</button>
      <button class="btn btn-outline" id="menuBtn">Menu</button>
      <button class="btn btn-primary" id="againBtn">Play again</button>
    </div>`;
  if (bounds.length) resultMap.fitBounds(L.latLngBounds(bounds), { padding: [50, 50], paddingBottomRight: [50, cardPadding()], maxZoom: 6, animate: false });
  $('againBtn').addEventListener('click', startCustom);
  $('menuBtn').addEventListener('click', showStart);
  $('copyBtn').addEventListener('click', (e) => copyText(`Onde? Country streak (${REGIONS[state.regionKey].label}): ${state.streak} 🔥\n${flags}\n${baseUrl()}`, e.currentTarget, 'Copy result'));
  $('againBtn').focus({ preventScroll: true });
}

function copyText(text, btn, label, done = 'Copied') {
  navigator.clipboard?.writeText(text).then(
    () => { btn.textContent = done; setTimeout(() => (btn.textContent = label), 1800); },
    () => { btn.textContent = 'Copy failed'; }
  );
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
function readChallengeFromUrl() {
  const m = location.hash.match(/#c=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const c = b64url.decode(m[1]);
    if (c?.v === 1 && Array.isArray(c.s) && c.s.length === ROUNDS && ['street', 'photo'].includes(c.m)) return c;
  } catch { /* bad link */ }
  return null;
}

renderRegions();
if (hasMapillary()) $('mlyCredit').hidden = false;
state.challenge = readChallengeFromUrl();

$('setup').addEventListener('change', renderSetup);
$('setup').addEventListener('submit', (e) => { e.preventDefault(); startCustom(); });
$('challengeBtn').addEventListener('click', startChallenge);
$('challengeDismiss').addEventListener('click', () => { state.challenge = null; history.replaceState(null, '', baseUrl()); renderChallenge(); });
$('guessBtn').addEventListener('click', () => submitGuess());
$('retryBtn').addEventListener('click', () => { state.prefetch = null; nextRound(); });
$('switchBtn').addEventListener('click', () => { state.mode = 'photo'; state.prefetch = null; nextRound(); });
$('quitBtn').addEventListener('click', () => {
  if (state.phase === 'summary' || confirm('Leave this game? Your score so far will be lost.')) showStart();
});
$('stageImg').addEventListener('click', toggleZoom);
$('stageImg').addEventListener('mousemove', panZoom);
$('compass').addEventListener('click', () => viewer?.faceNorth());
$('returnBtn').addEventListener('click', () => viewer?.backToStart());
$('openMapBtn').addEventListener('click', () => {
  $('guessPanel').classList.add('open');
  setTimeout(() => guessMap.invalidateSize(), 320);
});
$('closeMapBtn').addEventListener('click', () => $('guessPanel').classList.remove('open'));
$('guessPanel').addEventListener('transitionend', () => guessMap?.invalidateSize());

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (state.phase !== 'guessing') return;
  if ((e.key === ' ' || e.key === 'Enter') && state.guess && !e.target.matches('button')) { e.preventDefault(); submitGuess(); return; }
  if (state.current?.kind === 'pano' && state.move === 'move' && viewer) {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { e.preventDefault(); viewer.stepForward(); }
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { e.preventDefault(); viewer.stepForward(true); }
  }
});

// Installable app: offline shell + an install button where the browser supports it.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('installBox').hidden = false; });
window.addEventListener('appinstalled', () => { $('installBox').hidden = true; });
$('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('installBox').hidden = true;
});

showStart();
if (state.challenge) $('challengeBtn').focus({ preventScroll: true });
