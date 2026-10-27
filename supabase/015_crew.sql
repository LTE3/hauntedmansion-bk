-- The crew list for the admin page's Crew tab (owner, 2026-10-26: Cali
-- needs to see who is on this week and everyone who has worked).
--
-- Read-only on the page. Rows are written by hand (SQL) when the owner says
-- who is on - the owner does the scheduling and the pay, so nothing here
-- books a shift or holds a rate. Names and phone numbers live only in the
-- database: this repo publishes to GitHub Pages, so no row is seeded here.
--
-- Only hm-admin (service role) reads it.

create table if not exists public.hm_crew (
  id         bigint generated always as identity primary key,
  name       text not null,
  phone      text,
  role       text not null default 'actor',
  this_week  text,                         -- null = not on this week
  worked     text,                         -- nights worked, free text
  note       text,
  sort       int not null default 100,
  created_at timestamptz not null default now()
);

alter table public.hm_crew enable row level security;
revoke all on public.hm_crew from anon, authenticated;