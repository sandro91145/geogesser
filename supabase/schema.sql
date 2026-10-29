-- Onde? daily challenge leaderboard (Supabase / PostgreSQL).
-- Run once in the Supabase SQL Editor. Project settings used: Data API on,
-- "Automatically expose new tables" off, automatic RLS on.
create table public.daily_scores (
  id uuid primary key default gen_random_uuid(),
  day date not null default (now() at time zone 'utc')::date,
  player uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 20),
  score integer not null check (score between 0 and 25000),
  points integer[] not null check (array_length(points, 1) = 5 and 0 <= all (points) and 5000 >= all (points)),
  created_at timestamptz not null default now(),
  unique (day, player)
);

create index daily_scores_day_score on public.daily_scores (day, score desc);

alter table public.daily_scores enable row level security;

-- The game may read names and scores, and add a score. Nothing can be edited or deleted.
grant select (id, day, name, score, points, created_at) on public.daily_scores to anon, authenticated;
grant insert (day, player, name, score, points) on public.daily_scores to anon, authenticated;

create policy "Anyone can read the leaderboard"
  on public.daily_scores for select to anon, authenticated
  using (true);

create policy "Anyone can add a score for today"
  on public.daily_scores for insert to anon, authenticated
  with check (
    day = (now() at time zone 'utc')::date
    and score = (select coalesce(sum(p), 0) from unnest(points) as p)
  );
