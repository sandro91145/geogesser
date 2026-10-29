// Live duels: two players, same street view, real time.
//
// Transport: a Supabase Realtime broadcast channel per duel ("onde-duel-CODE").
// No database tables: messages go browser to browser through Supabase.
//
// Rules (like GeoGuessr Duels): both start with 6,000 health. Both see the same
// place. Once one player guesses, the other has 15 seconds. The lower score
// loses the difference in points × the round multiplier (×1 for rounds 1–4,
// then +0.5 each round). First to 0 loses.
//
// The host picks every location and tells the guest. Both clients compute the
// round result from the same two guesses, so they always agree.
//
// Messages: { t: 'hello' | 'start' | 'round' | 'ready' | 'go' | 'guess' | 'next' | 'ping' | 'bye', ... }

import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=10';

const START_HP = 6000;
const AFTER_FIRST_GUESS = 15;   // seconds the other player gets
const LOST_AFTER = 25;          // seconds without any message = opponent gone
const multiplier = (n) => 1 + Math.max(0, n - 4) * 0.5;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let sbLib = null;
const loadSupabase = () => (sbLib ||= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm'));

export const hasDuels = () => !!(SUPABASE_URL && SUPABASE_KEY);

export function initDuel(app) {
  const { $, state, REGIONS } = app;
  let D = null;   // current duel

  const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const myId = () => {
    let id = sessionStorage.getItem('onde.duel.id');
    if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); sessionStorage.setItem('onde.duel.id', id); }
    return id;
  };
  const link = () => `${app.baseUrl()}#duel=${D.code}`;
  const oppName = () => D?.opp?.name || 'Your friend';

  /* ---------- connection ---------- */
  async function connect(code, role) {
    leave(true);
    const { createClient } = await loadSupabase();
    D = {
      code, role, client: createClient(SUPABASE_URL, SUPABASE_KEY),
      me: { id: myId(), name: app.savedName() || (role === 'host' ? 'Host' : 'Guest') },
      opp: null, region: 'world', move: 'move',
      hp: { me: START_HP, opp: START_HP }, n: 0, phase: 'lobby',
      history: [], used: new Set(), prefetch: null, lastSeen: Date.now(),
      ready: {}, nextReady: {}, timers: {},
    };
    const ch = D.client.channel(`onde-duel-${code}`, { config: { broadcast: { self: false } } });
    D.ch = ch;
    ch.on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload));
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout')), 12000);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearTimeout(to); resolve(); }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(to); reject(new Error(status)); }
      });
    });
    D.timers.ping = setInterval(() => {
      send({ t: 'ping' });
      if (D?.opp && D.phase !== 'over' && Date.now() - D.lastSeen > LOST_AFTER * 1000) lost();
    }, 4000);
    send({ t: 'hello', id: D.me.id, name: D.me.name, role });
  }

  function send(msg) {
    if (!D?.ch) return;
    D.ch.send({ type: 'broadcast', event: 'm', payload: { ...msg, from: D.me.id } }).catch(() => {});
  }

  function leave(silent = false) {
    if (!D) return;
    if (!silent) send({ t: 'bye' });
    Object.values(D.timers).forEach((t) => { clearInterval(t); clearTimeout(t); });
    const old = D;
    D = null;
    setTimeout(() => old.client?.removeAllChannels?.(), 300);
    if (location.hash.startsWith('#duel=')) history.replaceState(null, '', app.baseUrl());
  }

  /* ---------- lobby ---------- */
  async function create() {
    openLobby('host');
    lobbyStatus('Setting up the duel…');
    try {
      await connect(randomCode(), 'host');
      renderLobby();
    } catch { lobbyStatus("Couldn't connect. Check your internet connection and try again.", true); }
  }

  async function join(code) {
    openLobby('guest');
    lobbyStatus(`Joining duel ${code}…`);
    try {
      await connect(code, 'guest');
      renderLobby();
      lobbyStatus('Connected. Waiting for the host to answer…');
      D.timers.noHost = setTimeout(() => { if (D && !D.opp) lobbyStatus("The host isn't here. The duel may have ended, or the link is wrong.", true); }, 10000);
    } catch { lobbyStatus("Couldn't connect. Check your internet connection and try again.", true); }
  }

  function openLobby(role) {
    $('start').hidden = true;
    $('game').hidden = true;
    $('lobby').hidden = false;
    $('lobbyHost').hidden = role !== 'host';
    $('lobbyStart').hidden = role !== 'host';
    $('lobbyTitle').textContent = role === 'host' ? 'Duel a friend' : 'Join a duel';
    $('lobbyName').value = app.savedName();
  }

  function renderLobby() {
    if (!D) return;
    $('lobbyCode').textContent = D.code;
    $('lobbyLink').value = link();
    $('lobbyShare').hidden = D.role !== 'host';
    $('lobbyStart').disabled = !D.opp;
    if (D.role === 'host') lobbyStatus(D.opp ? `${D.opp.name} joined. Start when you're ready.` : 'Send your friend the link. Waiting for them to join…');
    else if (D.opp) lobbyStatus(`Connected to ${D.opp.name}. Waiting for them to start the duel…`);
  }

  function lobbyStatus(text, isError = false) {
    $('lobbyStatus').textContent = text;
    $('lobbyStatus').classList.toggle('error', isError);
  }

  function setName(name) {
    if (!D) return;
    D.me.name = name.replace(/\s+/g, ' ').trim().slice(0, 20) || D.me.name;
    try { localStorage.setItem('onde.name', JSON.stringify(D.me.name)); } catch { /* ignore */ }
    send({ t: 'hello', id: D.me.id, name: D.me.name, role: D.role, again: true });
  }

  /* ---------- messages ---------- */
  function onMessage(m) {
    if (!D || m.from === D.me.id) return;
    if (D.opp && m.from !== D.opp.id && m.t !== 'hello') return;   // ignore strangers
    D.lastSeen = Date.now();
    switch (m.t) {
      case 'hello':
        if (D.opp && D.opp.id !== m.id) { send({ t: 'full', to: m.id }); return; }   // already two players
        if (m.role === D.role) return;
        { const isNew = !D.opp; D.opp = { id: m.id, name: (m.name || 'Friend').slice(0, 20) }; clearTimeout(D.timers.noHost);
          if (isNew || !m.again) send({ t: 'hello', id: D.me.id, name: D.me.name, role: D.role, again: true });
          if (D.phase === 'lobby') renderLobby(); else updateHud(); }
        break;
      case 'full':
        if (m.to === D.me.id) { lobbyStatus('This duel already has two players.', true); leave(true); }
        break;
      case 'start': if (D.role === 'guest') beginDuel(m); break;
      case 'round': if (D.role === 'guest') loadRound(m.n, m.spec); break;
      case 'ready': D.ready[m.n] = true; if (D.role === 'host') maybeGo(m.n); break;
      case 'go': if (D.role === 'guest' && m.n === D.n) go(); break;
      case 'guess': if (m.n === D.n) gotOppGuess(m.g); break;
      case 'next': D.nextReady[m.n] = true; if (D.role === 'host') maybeNext(m.n); break;
      case 'bye': lost(true); break;
      default: break;
    }
  }

  function lost(left = false) {
    if (!D || D.phase === 'over' || D.phase === 'gone') return;
    D.phase = 'gone';
    app.stopTimer();
    const text = left ? `${oppName()} left the duel.` : `Lost connection to ${oppName()}.`;
    if (!$('lobby').hidden) { lobbyStatus(text, true); $('lobbyStart').disabled = true; return; }
    $('result').hidden = false;
    $('resultCard').innerHTML = `<p class="streak-verdict">${app.escapeHTML(text)}</p>
      <div class="r-actions"><button class="btn btn-primary" id="duelMenu">Back to menu</button></div>`;
    $('duelMenu').addEventListener('click', () => { leave(); app.showStart(); });
  }

  /* ---------- game ---------- */
  function startAsHost() {
    if (!D || D.role !== 'host' || !D.opp) return;
    const form = $('lobbyForm');
    send({ t: 'start', region: form.duelRegion.value, move: form.duelMove.value });
    beginDuel({ region: form.duelRegion.value, move: form.duelMove.value });
  }

  function beginDuel({ region, move }) {
    Object.assign(D, { region: REGIONS[region] ? region : 'world', move, hp: { me: START_HP, opp: START_HP }, n: 0, history: [], phase: 'loading', ready: {}, nextReady: {} });
    D.used = new Set();
    Object.assign(state, { kind: 'duel', game: 'classic', mode: 'street', regionKey: D.region, move: D.move, timerSecs: 0, round: 0, total: 0, results: [] });
    state.usedTitles.clear();
    $('lobby').hidden = true;
    $('start').hidden = true;
    $('game').hidden = false;
    $('game').classList.add('is-duel');
    app.ensureMaps();
    updateHud();
    if (D.role === 'host') hostNextRound();
    else app.showLoading(`Waiting for ${oppName()}…`);
  }

  async function hostNextRound() {
    const n = D.n + 1;
    app.showLoading('Finding a place…');
    try {
      let loc = D.prefetch ? await D.prefetch : null;
      D.prefetch = null;
      if (!loc) loc = await app.findPano(REGIONS[D.region], D.used);
      if (!D) return;
      D.used.add(String(loc.id));
      send({ t: 'round', n, spec: app.specOf(loc) });
      loadRound(n, null, loc);
      D.prefetch = app.findPano(REGIONS[D.region], D.used).catch(() => null);
    } catch {
      app.showLoading("Couldn't find a street view. Trying again…");
      setTimeout(() => D && hostNextRound(), 1500);
    }
  }

  async function loadRound(n, spec, loc = null) {
    if (!D) return;
    D.n = n;
    D.phase = 'loading';
    D.loc = null;
    D.myGuess = undefined;
    D.oppGuess = undefined;
    D.firstGuessAt = null;
    clearTimeout(D.timers.countdown); clearInterval(D.timers.tick);
    state.round = n;
    state.phase = 'loading';
    $('result').hidden = true;
    $('duelWait').hidden = true;
    $('guessPanel').classList.remove('pinned', 'open');
    app.resetGuessMap();
    updateHud();
    app.showLoading(`Round ${n}${multiplier(n) > 1 ? ` · damage ×${multiplier(n)}` : ''}`);
    try {
      loc ||= await app.locFromSpec(spec);
      if (!D || D.n !== n) return;
      D.loc = loc;
      state.current = loc;
      await app.showLocation(loc);
      app.showLoading(`Waiting for ${oppName()} to load…`);
      D.ready[`me${n}`] = true;
      send({ t: 'ready', n });
      if (D.role === 'host') {
        maybeGo(n);
        D.timers.goFallback = setTimeout(() => D && D.n === n && D.phase === 'loading' && (send({ t: 'go', n }), go()), 20000);
      }
    } catch {
      app.showLoading("This street view didn't load. Waiting for the next one…");
    }
  }

  function maybeGo(n) {
    if (D.n === n && D.ready[`me${n}`] && D.ready[n] && D.phase === 'loading') {
      clearTimeout(D.timers.goFallback);
      send({ t: 'go', n });
      go();
    }
  }

  function go() {
    if (!D) return;
    D.phase = 'playing';
    app.hideLoading();
    state.phase = 'guessing';
    $('guessBtn').textContent = 'Place a pin on the map';
  }

  // The player pressed Guess (or their time ran out).
  function submit(fromTimeout = false) {
    if (!D || D.phase !== 'playing' || D.myGuess !== undefined) return;
    if (!state.guess && !fromTimeout) return;
    const g = state.guess ? state.guess.wrap() : null;
    D.myGuess = g ? { lat: +g.lat.toFixed(5), lng: +g.lng.toFixed(5) } : null;
    state.phase = 'waiting';
    send({ t: 'guess', n: D.n, g: D.myGuess });
    $('guessBtn').disabled = true;
    $('guessPanel').classList.remove('open');
    if (D.oppGuess === undefined) {
      startCountdown(false);
      showWait(`Waiting for ${oppName()} to guess…`);
    }
    maybeResolve();
  }

  function gotOppGuess(g) {
    if (!D || D.oppGuess !== undefined) return;
    D.oppGuess = g || null;
    if (D.myGuess === undefined && D.phase === 'playing') {
      toast(`${oppName()} guessed. You have ${AFTER_FIRST_GUESS} seconds.`);
      startCountdown(true);
    }
    maybeResolve();
  }

  // mine = true: my own time is running out. Otherwise show the opponent's time.
  function startCountdown(mine) {
    if (D.firstGuessAt) return;
    D.firstGuessAt = Date.now();
    const end = D.firstGuessAt + AFTER_FIRST_GUESS * 1000;
    $('hudTimerWrap').hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      $('hudTimer').textContent = `0:${String(left).padStart(2, '0')}`;
      $('hudTimerWrap').classList.toggle('urgent', left <= 5);
      if (!mine && D.oppGuess === undefined) $('duelWaitText').textContent = `Waiting for ${oppName()} to guess… ${left} s`;
    };
    tick();
    D.timers.tick = setInterval(tick, 250);
    if (mine) D.timers.countdown = setTimeout(() => submit(true), AFTER_FIRST_GUESS * 1000);
    // If their guess never arrives (e.g. they lost connection), score it as no guess.
    else D.timers.countdown = setTimeout(() => { if (D && D.oppGuess === undefined) { D.oppGuess = null; maybeResolve(); } }, (AFTER_FIRST_GUESS + 6) * 1000);
  }

  function maybeResolve() {
    if (!D || D.myGuess === undefined || D.oppGuess === undefined || D.phase !== 'playing') return;
    D.phase = 'result';
    state.phase = 'result';
    clearTimeout(D.timers.countdown); clearInterval(D.timers.tick);
    $('hudTimerWrap').hidden = true;
    $('duelWait').hidden = true;
    const loc = D.loc;
    const truth = { lat: loc.lat, lng: loc.lng };
    const scale = REGIONS[D.region].scale;
    const score = (g) => (g ? app.scoreFor(app.haversine(g, truth), scale) : 0);
    const km = (g) => (g ? app.haversine(g, truth) : null);
    const mine = { g: D.myGuess, km: km(D.myGuess), pts: score(D.myGuess) };
    const theirs = { g: D.oppGuess, km: km(D.oppGuess), pts: score(D.oppGuess) };
    const mult = multiplier(D.n);
    const damage = Math.round(Math.abs(mine.pts - theirs.pts) * mult);
    const hurt = mine.pts > theirs.pts ? 'opp' : mine.pts < theirs.pts ? 'me' : null;
    if (hurt) D.hp[hurt] = Math.max(0, D.hp[hurt] - damage);
    D.history.push({ n: D.n, loc, mine, theirs, damage, hurt, mult });
    updateHud();
    showRoundResult(D.history[D.history.length - 1]);
  }

  function showRoundResult(r) {
    const over = D.hp.me <= 0 || D.hp.opp <= 0;
    if (over) D.phase = 'over';
    $('result').hidden = false;
    app.resultMap().invalidateSize();
    const layer = app.resultLayer();
    layer.clearLayers();
    const truth = L.latLng(r.loc.lat, r.loc.lng);
    L.marker(truth, { icon: app.makePin('truth'), keyboard: false }).addTo(layer);
    const pts = [truth];
    for (const [who, side] of [['guess', r.mine], ['opp', r.theirs]]) {
      if (!side.g) continue;
      const near = app.nearCopy(truth, L.latLng(side.g.lat, side.g.lng));
      L.marker(near, { icon: app.makePin(who), keyboard: false }).addTo(layer);
      L.polyline([near, truth], { color: who === 'opp' ? '#2B6CB0' : '#16243A', weight: 3, dashArray: '2 8', lineCap: 'round' }).addTo(layer);
      pts.push(near);
    }
    const e = app.escapeHTML, name = e(oppName());
    const line = (label, side) => `<li><span class="s-name">${label}</span><span class="s-pts">${app.fmt(side.pts)}<span class="s-km">${side.km == null ? 'no guess' : app.fmtKm(side.km)}</span></span></li>`;
    const verdict = !r.hurt ? 'Draw' : r.hurt === 'opp' ? `${name} loses ${app.fmt(r.damage)}` : `You lose ${app.fmt(r.damage)}`;
    const nextLabel = over ? 'See who won' : 'Next round';
    $('resultCard').innerHTML = `
      <p class="duel-round">Round ${r.n}${r.mult > 1 ? ` · damage ×${r.mult}` : ''}</p>
      <p class="streak-verdict ${r.hurt === 'opp' ? 'ok' : r.hurt === 'me' ? 'bad' : ''}">${verdict}</p>
      <p class="r-where" id="duelWhere"></p>
      <ol class="sum-list duel-list">${line('You', r.mine)}${line(name, r.theirs)}</ol>
      ${hpBars()}
      <p class="r-credit">Imagery by ${e(r.loc.author)}${r.loc.license ? `, ${e(r.loc.license)}` : ''}. <a href="${r.loc.page}" target="_blank" rel="noopener">View on ${r.loc.source === 'mapillary' ? 'Mapillary' : 'Panoramax'}</a></p>
      <p class="lb-note" id="duelNote"></p>
      <div class="r-actions"><button class="btn btn-primary" id="duelNext">${nextLabel}</button></div>`;
    app.placeName(r.loc).then((p) => { const el = $('duelWhere'); if (el && p) el.textContent = `${r.loc.flag ? r.loc.flag + ' ' : ''}${p}`; });
    app.resultMap().fitBounds(L.latLngBounds(pts), { padding: [60, 60], paddingBottomRight: [60, app.cardPadding()], maxZoom: 12, animate: false });
    $('duelNext').addEventListener('click', () => {
      if (over) { showFinal(); return; }
      $('duelNext').disabled = true;
      $('duelNext').textContent = `Waiting for ${oppName()}…`;
      D.nextReady[`me${r.n}`] = true;
      send({ t: 'next', n: r.n });
      if (D.role === 'host') maybeNext(r.n);
    });
    $('duelNext').focus({ preventScroll: true });
    // Don't wait forever for a slow click: the host moves on after 20 s.
    if (!over && D.role === 'host') D.timers.nextFallback = setTimeout(() => D && D.n === r.n && hostNextRound(), 20000);
  }

  function maybeNext(n) {
    if (D.n === n && D.nextReady[`me${n}`] && D.nextReady[n] && D.phase === 'result') {
      clearTimeout(D.timers.nextFallback);
      hostNextRound();
    }
  }

  function showFinal() {
    const won = D.hp.opp <= 0 && D.hp.me > 0;
    const layer = app.resultLayer();
    layer.clearLayers();
    const bounds = [];
    D.history.forEach((r, i) => {
      const ll = L.latLng(r.loc.lat, r.loc.lng);
      L.marker(ll, { icon: app.makePin('truth', i + 1), keyboard: false }).addTo(layer);
      bounds.push(ll);
    });
    const e = app.escapeHTML;
    const rows = D.history.map((r) => `<li><span class="s-name">${r.loc.place ? `${r.loc.flag || ''} ${e(r.loc.place)}` : `Round ${r.n}`}</span>
      <span class="s-pts">${app.fmt(r.mine.pts)} – ${app.fmt(r.theirs.pts)}</span></li>`).join('');
    $('resultCard').innerHTML = `
      <p class="sum-total">${won ? 'You win' : `${e(oppName())} wins`}</p>
      <p class="sum-sub">${D.history.length} rounds. You ${app.fmt(D.hp.me)} health, ${e(oppName())} ${app.fmt(D.hp.opp)}.</p>
      <ol class="sum-list">${rows}</ol>
      <p class="lb-note" id="duelNote">${D.role === 'host' ? '' : `${e(oppName())} can start a rematch.`}</p>
      <div class="r-actions">
        <button class="btn btn-outline" id="duelLeave">Leave duel</button>
        ${D.role === 'host' ? '<button class="btn btn-primary" id="duelRematch">Rematch</button>' : ''}
      </div>`;
    if (bounds.length) app.resultMap().fitBounds(L.latLngBounds(bounds), { padding: [50, 50], paddingBottomRight: [50, app.cardPadding()], maxZoom: 6, animate: false });
    $('duelLeave').addEventListener('click', () => { leave(); app.showStart(); });
    $('duelRematch')?.addEventListener('click', () => {
      send({ t: 'start', region: D.region, move: D.move });
      beginDuel({ region: D.region, move: D.move });
    });
  }

  /* ---------- HUD bits ---------- */
  function hpBars() {
    const bar = (label, hp, cls) => `<div class="hp ${cls}"><span class="hp-name">${label}</span><span class="hp-bar"><i style="width:${(hp / START_HP) * 100}%"></i></span><span class="hp-num">${app.fmt(hp)}</span></div>`;
    return `<div class="hp-bars">${bar('You', D.hp.me, 'hp-me')}${bar(app.escapeHTML(oppName()), D.hp.opp, 'hp-opp')}</div>`;
  }
  function updateHud() {
    if (!D) return;
    $('hudDuel').innerHTML = `${hpBars()}<span class="hud-duel-round">Round ${Math.max(1, D.n)}${multiplier(D.n) > 1 ? ` · ×${multiplier(D.n)}` : ''}</span>`;
  }
  function showWait(text) {
    $('duelWait').hidden = false;
    $('duelWaitText').textContent = text;
  }
  function toast(text) {
    const el = $('duelToast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(D.timers.toast);
    D.timers.toast = setTimeout(() => { el.hidden = true; }, 4000);
  }

  /* ---------- wiring ---------- */
  $('lobbyCopy').addEventListener('click', (e) => app.copyText(`Duel me on Onde? ${link()}`, e.currentTarget, 'Copy link', 'Link copied'));
  $('lobbyName').addEventListener('change', (e) => setName(e.target.value));
  $('lobbyStart').addEventListener('click', () => { setName($('lobbyName').value); startAsHost(); });
  $('lobbyLeave').addEventListener('click', () => { leave(); $('lobby').hidden = true; app.showStart(); });

  return {
    create, join, submit: () => submit(false), leave,
    active: () => !!D,
    onExit: () => { leave(); $('game').classList.remove('is-duel'); },
  };
}
