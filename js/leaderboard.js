// Daily challenge leaderboard, stored in Supabase (table public.daily_scores).
// Talks to Supabase's REST API directly; no client library needed.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=11';

export const hasLeaderboard = () => !!(SUPABASE_URL && SUPABASE_KEY);
const API = `${SUPABASE_URL}/rest/v1/daily_scores`;
const headers = (extra = {}) => ({ apikey: SUPABASE_KEY, ...extra });

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// A random ID per browser, so each player has one entry per day.
export function playerId() {
  let id = store.get('onde.player');
  if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)); store.set('onde.player', id); }
  return id;
}
export const savedName = () => store.get('onde.name') || '';
export const submittedToday = (day) => store.get(`onde.lb.${day}`);

async function timed(url, opts = {}, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

export async function topScores(day, limit = 10) {
  const res = await timed(`${API}?day=eq.${day}&select=name,score,points,created_at&order=score.desc,created_at.asc&limit=${limit}`, { headers: headers() });
  if (!res.ok) throw new Error(`Leaderboard unavailable (${res.status})`);
  return res.json();
}

// How many players today, and how many scored more than `score`.
export async function rankOf(day, score) {
  const count = async (filter) => {
    const res = await timed(`${API}?day=eq.${day}${filter}&select=score&limit=1`, { headers: headers({ Prefer: 'count=exact' }) });
    if (!res.ok) throw new Error('count failed');
    return Number((res.headers.get('content-range') || '').split('/')[1]) || 0;
  };
  const [above, total] = await Promise.all([count(`&score=gt.${score}`), count('')]);
  return { rank: above + 1, total };
}

// Returns 'ok' | 'duplicate'; throws on other errors.
export async function submitScore({ day, name, score, points }) {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!clean) throw new Error('Enter a name');
  const res = await timed(API, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ day, player: playerId(), name: clean, score, points }),
  });
  store.set('onde.name', clean);
  if (res.status === 409) { store.set(`onde.lb.${day}`, { name: clean, score }); return 'duplicate'; }
  if (!res.ok) throw new Error(`Couldn't save your score (${res.status})`);
  store.set(`onde.lb.${day}`, { name: clean, score });
  return 'ok';
}
