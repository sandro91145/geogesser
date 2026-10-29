// Collects photo locations in bulk, the same way the game finds them live:
// asks the Wikidata Query Service for places with a photo (P18) near each seed
// point in js/seeds.js, then gets size, author and license from Commons.
// Used to (re)build data/fallback.json, the photos the game uses when the
// live search can't be reached.
//
// How to run (~3 minutes for all regions):
//   1. Open https://query.wikidata.org/ in a browser and open the developer console.
//   2. Paste this whole file, then run:
//        const seeds = {europe: [[lat, lng], ...], asia: [...], ...};   // from js/seeds.js
//        const pool = await harvest(seeds);
//   3. Pick ~20 varied entries per region, keep the fields t, la, lo, a, l,
//      and save them as data/fallback.json.
//   Progress is in window.__harvest.

const HARVEST_BAD = /\b(map|maps|karte|carte|mapa|plan|lageplan|logo|flag|bandeira|bandera|drapeau|coat of arms|wappen|bras[aã]o|escudo|blason|seal|emblem|diagram|chart|scan|document|signature|stamp|coin|banknote|poster|book|page|letter|manuscript|screenshot|satellite|portrait|painting|museum|exhibit|artefact|artifact|fossil|specimen|herbarium|inscription|plaque|grave|tomb|x-ray|microscop|aerial|a[eé]rea|from the air|from space|view of earth|iss\d+|flight|voo|vuelo|airplane|aircraft window|selfie|location|locator|svg)\b/i;

async function harvest(seedsByRegion, { perSeed = 4, radiusKm = { portugal: 12 }, defaultRadius = 20, concurrency = 4, resume = null } = {}) {
  const COMMONS = 'https://commons.wikimedia.org/w/api.php';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nice = (t) => t.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').trim();
  const text = (html, max) => {
    const s = new DOMParser().parseFromString(html || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  };
  const km = (a, b) => {
    const r = Math.PI / 180, s = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(s));
  };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  async function placesNear([lat, lng], radius) {
    const q = `SELECT ?item ?loc ?image WHERE {
      SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${radius}" . }
      ?item wdt:P18 ?image ; wdt:P17 ?country .
      FILTER NOT EXISTS { ?item wdt:P171 ?taxonParent }
    } LIMIT 150`;
    for (let tryNo = 0; tryNo < 5; tryNo++) {
      try {
        const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { headers: { Accept: 'application/sparql-results+json' } });
        if (res.ok) {
          return (await res.json()).results.bindings.map((b) => {
            const m = b.loc.value.match(/Point\(([-\d.eE]+) ([-\d.eE]+)\)/);
            return m && { file: decodeURIComponent(b.image.value.split('/').pop()).replace(/_/g, ' '), pos: [+m[2], +m[1]] };
          }).filter(Boolean);
        }
      } catch { /* retry */ }
      await sleep(1500 * (tryNo + 1));
    }
    return [];
  }

  async function fileInfo(files) {
    const out = new Map();
    for (let i = 0; i < files.length; i += 50) {
      const p = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', origin: '*',
        titles: files.slice(i, i + 50).map((f) => 'File:' + f).join('|'),
        prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280',
        iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription',
      });
      for (let tryNo = 0; tryNo < 4; tryNo++) {
        try {
          const d = await (await fetch(`${COMMONS}?${p}`)).json();
          for (const pg of d.query?.pages || []) if (pg.imageinfo) out.set(pg.title.replace(/^File:/, ''), pg.imageinfo[0]);
          break;
        } catch { await sleep(1500 * (tryNo + 1)); }
      }
    }
    return out;
  }

  // Work through every (region, seed) pair with a few requests in flight at once.
  // `resume` = { pool, skip } continues an earlier run: skip the first N seeds per region.
  const state = (window.__harvest = { done: 0, total: 0, pool: {}, seen: new Set() });
  const queue = [];
  for (const [region, seeds] of Object.entries(seedsByRegion)) {
    state.pool[region] = (resume?.pool?.[region] || []).slice();
    state.pool[region].forEach((x) => state.seen.add(x.t));
    seeds.slice(resume?.skip?.[region] || 0).forEach((seed) => queue.push({ region, seed }));
  }
  state.total = queue.length;

  async function work({ region, seed }) {
    const places = shuffle(await placesNear(seed, radiusKm[region] || defaultRadius))
      .filter((pl) => /\.jpe?g$/i.test(pl.file) && !HARVEST_BAD.test(nice(pl.file)) && !state.seen.has(pl.file))
      .slice(0, 14);
    const info = await fileInfo(places.map((pl) => pl.file));
    const picked = [];
    for (const pl of places) {
      if (picked.length >= perSeed) break;
      const ii = info.get(pl.file);
      if (!ii || ii.mime !== 'image/jpeg' || ii.width < 1000 || ii.height < 600) continue;
      const ratio = ii.width / ii.height;
      if (ratio < 0.6 || ratio > 2.7) continue;
      const stem = nice(pl.file).toLowerCase().replace(/[\d\s()_-]+$/g, '').slice(0, 14);
      if (picked.some((x) => x.stem === stem || km(x.pos, pl.pos) < 1)) continue;
      picked.push({ ...pl, stem, ii });
    }
    for (const pl of picked) {
      if (state.seen.has(pl.file)) continue;
      state.seen.add(pl.file);
      const md = pl.ii.extmetadata || {};
      state.pool[region].push({
        t: pl.file,
        la: +pl.pos[0].toFixed(5),
        lo: +pl.pos[1].toFixed(5),
        u: (pl.ii.thumburl || pl.ii.url).replace(/\?.*$/, ''),
        p: pl.ii.descriptionurl.replace(/\?.*$/, ''),
        a: text(md.Artist?.value, 60),
        l: text(md.LicenseShortName?.value, 30),
        d: text(md.ImageDescription?.value, 160),
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      await work(queue.shift());
      state.done++;
      await sleep(100);
    }
  }));
  state.finished = true;
  return state.pool;
}
