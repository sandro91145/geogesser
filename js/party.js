// Party game: up to 5 players, same street views in real time, 5 rounds,
// highest total score wins.
//
// Transport: a Supabase Realtime broadcast channel per game ("onde-party-CODE").
// The host is in charge: it keeps the player list, picks every location and
// decides when a round is over, then sends everyone the final set of guesses.
// Every browser computes the scores from that same set, so all agree.
//
// Messages: hello · roster · reject · start · round · ready · go · guess · result · ping · bye

import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=11';

const MAX_PLAYERS = 5;
const ROUNDS = 5;
const AFTER_FIRST_GUESS = 20;   // seconds everyone else gets once someone has guessed
const LOST_AFTER = 25;          // seconds of silence before a player counts as gone
const COLORS = ['#F2B705', '#4C8EDA', '#E0457B', '#2EAD6B', '#9B5DE5'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let sbLib = null;
const loadSupabase = () => (sbLib ||= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm'));

export const hasParty = () => !!(SUPABASE_URL && SUPABASE_KEY);

export function initParty(app) {
  const { $, state, REGIONS } = app;
  const e = (s) => app.escapeHTML(s);
  let P = null;   // current party

  const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const myId = () => {
    let id = sessionStorage.getItem('onde.party.id');
    if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); sessionStorage.setItem('onde.party.id', id); }
    return id;
  };
  const link = () => `${app.baseUrl()}#party=${P.code}`;
  const isHost = () => P?.role === 'host';
  const player = (id) => P.players.find((p) => p.id === id);
  const nameOf = (id) => (id === P.me.id ? 'You' : player(id)?.name || 'Someone');
  const colorOf = (id) => COLORS[Math.max(0, P.players.findIndex((p) => p.id === id)) % COLORS.length];

  /* ---------- connection ---------- */
  async function connect(code, role) {
    leave(true);
    const { createClient } = await loadSupabase();
    const me = { id: myId(), name: app.savedName() || (role === 'host' ? 'Host' : 'Player') };
    P = {
      code, role, me, client: createClient(SUPABASE_URL, SUPABASE_KEY),
      hostId: role === 'host' ? me.id : null,
      players: role === 'host' ? [me] : [],
      started: false, region: 'world', move: 'move', n: 0, phase: 'lobby',
      totals: {}, history: [], used: new Set(), prefetch: null,
      seen: {}, ready: {}, guesses: {}, timers: {},
    };
    const ch = P.client.channel(`onde-party-${code}`, { config: { broadcast: { self: false } } });
    P.ch = ch;
    ch.on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload));
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout')), 12000);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearTimeout(to); resolve(); }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(to); reject(new Error(status)); }
      });
    });
    P.timers.ping = setInterval(heartbeat, 4000);
    if (role === 'guest') send({ t: 'hello', name: me.name });
  }

  function send(msg) {
    if (!P?.ch) return;
    P.ch.send({ type: 'broadcast', event: 'm', payload: { ...msg, from: P.me.id } }).catch(() => {});
  }

  function heartbeat() {
    if (!P) return;
    send({ t: 'ping' });
    const now = Date.now();
    if (isHost()) {
      const gone = P.players.filter((p) => p.id !== P.me.id && now - (P.seen[p.id] || now) > LOST_AFTER * 1000);
      if (gone.length) { gone.forEach((p) => removePlayer(p.id, 'lost connection')); }
    } else if (P.hostId && now - (P.seen[P.hostId] || now) > LOST_AFTER * 1000) {
      ended('Lost connection to the host.');
    }
  }

  function leave(silent = false) {
    if (!P) return;
    if (!silent) send({ t: 'bye' });
    Object.values(P.timers).forEach((t) => { clearInterval(t); clearTimeout(t); });
    const old = P;
    P = null;
    setTimeout(() => old.client?.removeAllChannels?.(), 300);
    if (location.hash.startsWith('#party=')) history.replaceState(null, '', app.baseUrl());
  }

  /* ---------- lobby ---------- */
  async function create() {
    openLobby('host');
    status('Setting up the game…');
    try { await connect(randomCode(), 'host'); renderLobby(); }
    catch { status("Couldn't connect. Check your internet connection and try again.", true); }
  }

  async function join(code) {
    openLobby('guest');
    status(`Joining game ${code}…`);
    try {
      await connect(code, 'guest');
      status('Connected. Waiting for the host to let you in…');
      P.timers.noHost = setTimeout(() => { if (P && !P.hostId) status("The host isn't answering. The game may have ended, or the link is wrong.", true); }, 10000);
    } catch { status("Couldn't connect. Check your internet connection and try again.", true); }
  }

  function openLobby(role) {
    $('start').hidden = true;
    $('game').hidden = true;
    $('lobby').hidden = true;
    $('partyLobby').hidden = false;
    $('partyHost').hidden = role !== 'host';
    $('partyStart').hidden = role !== 'host';
    $('partyShare').hidden = true;
    $('partyTitle').textContent = role === 'host' ? 'Party game' : 'Join a party game';
    $('partyName').value = app.savedName();
    $('partyPlayers').innerHTML = '';
  }

  function renderLobby() {
    if (!P) return;
    $('partyShare').hidden = !isHost();
    $('partyCode').textContent = P.code;
    $('partyLink').value = link();
    $('partyPlayers').innerHTML = P.players.map((p) => `<li><span class="party-dot" style="background:${colorOf(p.id)}"></span>${e(p.name)}${p.id === P.hostId ? ' <em>host</em>' : ''}${p.id === P.me.id ? ' <em>you</em>' : ''}</li>`).join('')
      + Array.from({ length: MAX_PLAYERS - P.players.length }, () => '<li class="empty">Free spot</li>').join('');
    $('partyStart').disabled = P.players.length < 2;
    if (isHost()) status(P.players.length < 2 ? 'Send the link to up to 4 friends. You can start once someone has joined.' : `${P.players.length} of ${MAX_PLAYERS} players. Start when everyone's in.`);
    else if (P.hostId) status(`You're in. Waiting for ${e(player(P.hostId)?.name || 'the host')} to start…`);
  }

  function status(text, isError = false) {
    $('partyStatus').textContent = text;
    $('partyStatus').classList.toggle('error', isError);
  }

  function setName(name) {
    if (!P) return;
    P.me.name = name.replace(/\s+/g, ' ').trim().slice(0, 20) || P.me.name;
    try { localStorage.setItem('onde.name', JSON.stringify(P.me.name)); } catch { /* ignore */ }
    const mine = player(P.me.id);
    if (mine) mine.name = P.me.name;
    if (isHost()) broadcastRoster(); else send({ t: 'hello', name: P.me.name });
    renderLobby();
  }

  /* ---------- host: player list ---------- */
  function broadcastRoster() {
    send({ t: 'roster', players: P.players, host: P.me.id, started: P.started });
  }

  function removePlayer(id, why) {
    if (!player(id)) return;
    const name = player(id).name;
    P.players = P.players.filter((p) => p.id !== id);
    broadcastRoster();
    if (P.phase === 'lobby') renderLobby();
    else { toast(`${name} ${why === 'left' ? 'left the game' : 'lost connection'}.`); updateHud(); maybeResolve(); }
  }

  /* ---------- messages ---------- */
  function onMessage(m) {
    if (!P || m.from === P.me.id) return;
    P.seen[m.from] = Date.now();
    if (!isHost() && m.from !== P.hostId && !['roster', 'reject', 'guess', 'ping', 'bye', 'hello'].includes(m.t)) return;

    if (isHost()) {
      switch (m.t) {
        case 'hello': {
          const known = player(m.from);
          if (known) { known.name = String(m.name || known.name).slice(0, 20); broadcastRoster(); if (P.phase === 'lobby') renderLobby(); else updateHud(); return; }
          if (P.started) return send({ t: 'reject', to: m.from, why: 'This game has already started.' });
          if (P.players.length >= MAX_PLAYERS) return send({ t: 'reject', to: m.from, why: `This game is full (${MAX_PLAYERS} players).` });
          P.players.push({ id: m.from, name: String(m.name || 'Player').slice(0, 20) });
          broadcastRoster();
          renderLobby();
          return;
        }
        case 'ready': P.ready[m.n] ||= new Set(); P.ready[m.n].add(m.from); maybeGo(m.n); return;
        case 'guess': gotGuess(m.from, m.n, m.g); return;
        case 'bye': removePlayer(m.from, 'left'); return;
        default: return;
      }
    }

    // guest
    switch (m.t) {
      case 'roster':
        if (!m.players.some((p) => p.id === P.me.id)) {
          if (P.hostId === m.host && P.phase !== 'lobby') ended('You were removed from the game (connection lost).');
          return;
        }
        P.hostId = m.host;
        clearTimeout(P.timers.noHost);
        P.players = m.players;
        if (P.phase === 'lobby') renderLobby(); else updateHud();
        break;
      case 'reject': if (m.to === P.me.id) { status(m.why, true); leave(true); } break;
      case 'start': begin(m); break;
      case 'round': loadRound(m.n, m.spec); break;
      case 'go': if (m.n === P.n) go(); break;
      case 'guess': gotGuess(m.from, m.n, m.g); break;
      case 'result': if (m.n === P.n) showResult(m.guesses); break;
      case 'final': showFinal(); break;
      case 'bye': if (m.from === P.hostId) ended('The host ended the game.'); else if (player(m.from)) { toast(`${player(m.from).name} left the game.`); } break;
      default: break;
    }
  }

  function ended(text) {
    if (!P) return;
    const inLobby = !$('partyLobby').hidden;
    leave(true);
    app.stopTimer();
    if (inLobby) { status(text, true); $('partyStart').disabled = true; return; }
    $('result').hidden = false;
    $('resultCard').innerHTML = `<p class="streak-verdict">${e(text)}</p>
      <div class="r-actions"><button class="btn btn-primary" id="partyMenu">Back to menu</button></div>`;
    $('partyMenu').addEventListener('click', () => app.showStart());
  }

  /* ---------- game ---------- */
  function startAsHost() {
    if (!isHost() || P.players.length < 2) return;
    const form = $('partyForm');
    const settings = { region: form.partyRegion.value, move: form.partyMove.value };
    P.started = true;
    broadcastRoster();
    send({ t: 'start', ...settings });
    begin(settings);
  }

  function begin({ region, move }) {
    Object.assign(P, { region: REGIONS[region] ? region : 'world', move, n: 0, totals: {}, history: [], phase: 'loading', ready: {}, guesses: {}, started: true });
    P.used = new Set();
    Object.assign(state, { kind: 'party', game: 'classic', mode: 'street', regionKey: P.region, move: P.move, timerSecs: 0, round: 0, total: 0, results: [] });
    state.usedTitles.clear();
    $('partyLobby').hidden = true;
    $('start').hidden = true;
    $('game').hidden = false;
    $('game').classList.add('is-duel', 'is-party');
    app.ensureMaps();
    updateHud();
    if (isHost()) hostNextRound();
    else app.showLoading('Waiting for the host…');
  }

  async function hostNextRound() {
    clearTimeout(P.timers.next);
    const n = P.n + 1;
    app.showLoading('Finding a place…');
    try {
      let loc = P.prefetch ? await P.prefetch : null;
      P.prefetch = null;
      if (!loc) loc = await app.findPano(REGIONS[P.region], P.used);
      if (!P) return;
      P.used.add(String(loc.id));
      send({ t: 'round', n, spec: app.specOf(loc) });
      loadRound(n, null, loc);
      if (n < ROUNDS) P.prefetch = app.findPano(REGIONS[P.region], P.used).catch(() => null);
    } catch {
      app.showLoading("Couldn't find a street view. Trying again…");
      setTimeout(() => P && hostNextRound(), 1500);
    }
  }

  async function loadRound(n, spec, loc = null) {
    if (!P) return;
    Object.assign(P, { n, phase: 'loading', loc: null, firstGuessAt: null });
    P.guesses[n] = {};
    clearTimeout(P.timers.countdown); clearTimeout(P.timers.deadline); clearInterval(P.timers.tick);
    state.round = n;
    state.phase = 'loading';
    $('result').hidden = true;
    $('duelWait').hidden = true;
    $('hudTimerWrap').hidden = true;
    $('guessPanel').classList.remove('pinned', 'open');
    app.resetGuessMap();
    updateHud();
    app.showLoading(`Round ${n} of ${ROUNDS}`);
    try {
      loc ||= await app.locFromSpec(spec);
      if (!P || P.n !== n) return;
      P.loc = loc;
      state.current = loc;
      await app.showLocation(loc);
      app.showLoading('Waiting for everyone to load…');
      if (isHost()) {
        P.ready[n] ||= new Set();
        P.ready[n].add(P.me.id);
        maybeGo(n);
        P.timers.goFallback = setTimeout(() => P && P.n === n && P.phase === 'loading' && startRound(n), 20000);
      } else send({ t: 'ready', n });
    } catch {
      app.showLoading("This street view didn't load for you. You can still guess on the map when the round starts.");
      if (!isHost()) send({ t: 'ready', n });
    }
  }

  function maybeGo(n) {
    if (P.n !== n || P.phase !== 'loading') return;
    const ready = P.ready[n] || new Set();
    if (P.players.every((p) => ready.has(p.id))) startRound(n);
  }
  function startRound(n) {
    clearTimeout(P.timers.goFallback);
    send({ t: 'go', n });
    go();
  }

  function go() {
    if (!P) return;
    P.phase = 'playing';
    app.hideLoading();
    state.phase = 'guessing';
    updateHud();
  }

  function submit(fromTimeout = false) {
    if (!P || P.phase !== 'playing' || P.guesses[P.n]?.[P.me.id] !== undefined) return;
    if (!state.guess && !fromTimeout) return;
    const g = state.guess ? state.guess.wrap() : null;
    const mine = g ? { lat: +g.lat.toFixed(5), lng: +g.lng.toFixed(5) } : null;
    state.phase = 'waiting';
    $('guessBtn').disabled = true;
    $('guessPanel').classList.remove('open');
    send({ t: 'guess', n: P.n, g: mine });
    gotGuess(P.me.id, P.n, mine);
  }

  function gotGuess(id, n, g) {
    if (!P || n !== P.n || !P.guesses[n] || P.guesses[n][id] !== undefined) return;
    P.guesses[n][id] = g || null;
    if (id !== P.me.id && P.phase === 'playing' && P.guesses[n][P.me.id] === undefined) toast(`${player(id)?.name || 'Someone'} guessed.`);
    if (!P.firstGuessAt) startCountdown();
    updateHud();
    if (P.guesses[n][P.me.id] !== undefined) showWaiting();
    maybeResolve();
  }

  function startCountdown() {
    P.firstGuessAt = Date.now();
    const n = P.n;
    const end = P.firstGuessAt + AFTER_FIRST_GUESS * 1000;
    $('hudTimerWrap').hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      $('hudTimer').textContent = `0:${String(left).padStart(2, '0')}`;
      $('hudTimerWrap').classList.toggle('urgent', left <= 5);
      if (P?.guesses[n]?.[P.me.id] !== undefined) showWaiting(left);
    };
    tick();
    P.timers.tick = setInterval(tick, 250);
    P.timers.countdown = setTimeout(() => P && P.n === n && submit(true), AFTER_FIRST_GUESS * 1000);
    // The host closes the round a little after time is up, even if someone never answered.
    if (isHost()) P.timers.deadline = setTimeout(() => P && P.n === n && resolve(n), (AFTER_FIRST_GUESS + 3) * 1000);
  }

  function showWaiting(left) {
    const missing = P.players.filter((p) => P.guesses[P.n]?.[p.id] === undefined).length;
    if (!missing) { $('duelWait').hidden = true; return; }
    $('duelWait').hidden = false;
    $('duelWaitText').textContent = `Waiting for ${missing} ${missing === 1 ? 'player' : 'players'}…${left != null ? ` ${left} s` : ''}`;
  }

  function maybeResolve() {
    if (!isHost() || !P || P.phase !== 'playing') return;
    const got = P.guesses[P.n] || {};
    if (P.players.every((p) => got[p.id] !== undefined)) resolve(P.n);
  }

  function resolve(n) {
    if (!P || P.n !== n || P.phase !== 'playing') return;
    const final = {};
    for (const p of P.players) final[p.id] = P.guesses[n][p.id] ?? null;
    send({ t: 'result', n, guesses: final });
    showResult(final);
  }

  function showResult(guesses) {
    if (!P || P.phase === 'result') return;
    P.phase = 'result';
    state.phase = 'result';
    clearTimeout(P.timers.countdown); clearTimeout(P.timers.deadline); clearInterval(P.timers.tick);
    $('hudTimerWrap').hidden = true;
    $('duelWait').hidden = true;
    $('result').hidden = false;
    $('guessPanel').classList.remove('open');
    const loc = P.loc;
    const truth = { lat: loc.lat, lng: loc.lng };
    const scale = REGIONS[P.region].scale;
    const rows = Object.entries(guesses).map(([id, g]) => {
      const km = g ? app.haversine(g, truth) : null;
      const pts = g ? app.scoreFor(km, scale) : 0;
      P.totals[id] = (P.totals[id] || 0) + pts;
      return { id, g, km, pts };
    }).sort((a, b) => b.pts - a.pts);
    P.history.push({ n: P.n, loc, rows });
    updateHud();

    const layer = app.resultLayer();
    layer.clearLayers();
    app.resultMap().invalidateSize();
    const tl = L.latLng(truth.lat, truth.lng);
    L.marker(tl, { icon: app.makePin('truth'), keyboard: false }).addTo(layer);
    const bounds = [tl];
    for (const r of rows) {
      if (!r.g) continue;
      const near = app.nearCopy(tl, L.latLng(r.g.lat, r.g.lng));
      L.marker(near, { icon: pin(r.id), keyboard: false }).addTo(layer);
      L.polyline([near, tl], { color: colorOf(r.id), weight: 3, dashArray: '2 8', lineCap: 'round' }).addTo(layer);
      bounds.push(near);
    }
    const last = P.n >= ROUNDS;
    const best = rows[0];
    const headline = best && best.pts > 0 ? `${best.id === P.me.id ? 'You were' : `${e(nameOf(best.id))} was`} closest` : 'Nobody got close';
    $('resultCard').innerHTML = `
      <p class="duel-round">Round ${P.n} of ${ROUNDS}</p>
      <p class="streak-verdict">${headline}</p>
      <p class="r-where" id="partyWhere"></p>
      <ol class="sum-list party-list">${rows.map((r) => `<li class="${r.id === P.me.id ? 'me' : ''}">
        <span class="party-dot" style="background:${colorOf(r.id)}"></span>
        <span class="s-name">${e(nameOf(r.id))}</span>
        <span class="s-pts">+${app.fmt(r.pts)}<span class="s-km">${r.km == null ? 'no guess' : app.fmtKm(r.km)}</span></span></li>`).join('')}</ol>
      ${standings()}
      <p class="r-credit">Imagery by ${e(loc.author)}${loc.license ? `, ${e(loc.license)}` : ''}. <a href="${loc.page}" target="_blank" rel="noopener">View on ${loc.source === 'mapillary' ? 'Mapillary' : 'Panoramax'}</a></p>
      <div class="r-actions">${isHost()
        ? `<button class="btn btn-primary" id="partyNext">${last ? 'Show final results' : 'Next round'}</button>`
        : `<p class="lb-note">${last ? 'Final results in a moment…' : 'The host starts the next round.'}</p>`}</div>`;
    app.placeName(loc).then((p) => { const el = $('partyWhere'); if (el && p) el.textContent = `${loc.flag ? loc.flag + ' ' : ''}${p}`; });
    app.resultMap().fitBounds(L.latLngBounds(bounds), { padding: [60, 60], paddingBottomRight: [60, app.cardPadding()], maxZoom: 12, animate: false });

    if (isHost()) {
      const next = () => { clearTimeout(P.timers.next); if (last) { send({ t: 'final' }); showFinal(); } else hostNextRound(); };
      $('partyNext').addEventListener('click', next);
      $('partyNext').focus({ preventScroll: true });
      P.timers.next = setTimeout(() => P && P.phase === 'result' && next(), 25000);
    } else if (last) {
      // Guests show the final screen on their own after a short pause.
      P.timers.next = setTimeout(() => P && showFinal(), 6000);
    }
  }

  function standings() {
    const order = [...P.players].sort((a, b) => (P.totals[b.id] || 0) - (P.totals[a.id] || 0));
    return `<div class="party-standings"><p class="party-standings-title">Total after ${P.n} ${P.n === 1 ? 'round' : 'rounds'}</p><ol>${order.map((p, i) =>
      `<li class="${p.id === P.me.id ? 'me' : ''}"><span class="lb-rank">${i + 1}</span><span class="party-dot" style="background:${colorOf(p.id)}"></span><span class="lb-name">${e(p.name)}${p.id === P.me.id ? ' <em>(you)</em>' : ''}</span><span class="lb-score">${app.fmt(P.totals[p.id] || 0)}</span></li>`).join('')}</ol></div>`;
  }

  function showFinal() {
    if (!P) return;
    P.phase = 'over';
    clearTimeout(P.timers.next);
    $('result').hidden = false;
    const order = [...P.players].sort((a, b) => (P.totals[b.id] || 0) - (P.totals[a.id] || 0));
    const top = P.totals[order[0]?.id] || 0;
    const winners = order.filter((p) => (P.totals[p.id] || 0) === top);
    const youWon = winners.some((w) => w.id === P.me.id);
    const headline = winners.length > 1 ? `A tie at ${app.fmt(top)}` : youWon ? 'You win! 🏆' : `${e(winners[0].name)} wins 🏆`;
    const layer = app.resultLayer();
    layer.clearLayers();
    const bounds = P.history.map((h, i) => {
      const ll = L.latLng(h.loc.lat, h.loc.lng);
      L.marker(ll, { icon: app.makePin('truth', i + 1), keyboard: false }).addTo(layer);
      return ll;
    });
    $('resultCard').innerHTML = `
      <p class="sum-total party-winner">${headline}</p>
      <ol class="party-podium">${order.map((p, i) => `<li class="${p.id === P.me.id ? 'me' : ''}">
        <span class="party-place">${['🥇', '🥈', '🥉'][i] || i + 1}</span><span class="party-dot" style="background:${colorOf(p.id)}"></span>
        <span class="lb-name">${e(p.name)}${p.id === P.me.id ? ' <em>(you)</em>' : ''}</span><span class="lb-score">${app.fmt(P.totals[p.id] || 0)}</span></li>`).join('')}</ol>
      <p class="sum-sub">${P.history.map((h) => h.loc.place ? `${h.loc.flag || ''} ${e(h.loc.place)}` : `Round ${h.n}`).join(' · ')}</p>
      <div class="r-actions">
        <button class="btn btn-outline" id="partyLeave">Leave game</button>
        ${isHost() ? '<button class="btn btn-primary" id="partyAgain">Play again</button>' : '<p class="lb-note">The host can start another game.</p>'}
      </div>`;
    if (bounds.length) app.resultMap().fitBounds(L.latLngBounds(bounds), { padding: [50, 50], paddingBottomRight: [50, app.cardPadding()], maxZoom: 6, animate: false });
    $('partyLeave').addEventListener('click', () => app.showStart());
    $('partyAgain')?.addEventListener('click', () => { send({ t: 'start', region: P.region, move: P.move }); begin({ region: P.region, move: P.move }); });
  }

  /* ---------- HUD ---------- */
  function pin(id) {
    const initial = (player(id)?.name || '?').trim().charAt(0).toUpperCase();
    return L.divIcon({ className: '', html: `<div class="pin" style="background:${colorOf(id)}"><span class="pin-label">${e(initial)}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 31] });
  }
  function updateHud() {
    if (!P) return;
    const order = [...P.players].sort((a, b) => (P.totals[b.id] || 0) - (P.totals[a.id] || 0));
    const rank = order.findIndex((p) => p.id === P.me.id) + 1;
    const guessed = Object.keys(P.guesses[P.n] || {}).length;
    $('hudDuel').innerHTML = `
      <div class="party-hud"><span><strong>Round ${Math.max(1, P.n)}/${ROUNDS}</strong></span>
      <span>${app.fmt(P.totals[P.me.id] || 0)} pts · ${rank ? `#${rank} of ${P.players.length}` : ''}</span></div>
      ${P.phase === 'playing' ? `<span class="hud-duel-round">${guessed} of ${P.players.length} guessed</span>` : ''}`;
  }
  function toast(text) {
    const el = $('duelToast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(P.timers.toast);
    P.timers.toast = setTimeout(() => { el.hidden = true; }, 3500);
  }

  /* ---------- wiring ---------- */
  $('partyCopy').addEventListener('click', (ev) => app.copyText(`Join my Onde? game: ${link()}`, ev.currentTarget, 'Copy link', 'Link copied'));
  $('partyName').addEventListener('change', (ev) => setName(ev.target.value));
  $('partyStart').addEventListener('click', () => { setName($('partyName').value); startAsHost(); });
  $('partyLeaveLobby').addEventListener('click', () => { leave(); $('partyLobby').hidden = true; app.showStart(); });

  return {
    create, join, submit: () => submit(false),
    onExit: () => { leave(); $('game').classList.remove('is-duel', 'is-party'); },
  };
}
