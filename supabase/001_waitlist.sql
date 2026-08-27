-- Waitlist for the house. Anonymous visitors may add themselves and may read
-- nothing back except the total, which the page shows only because it is real.

create table if not exists public.hm_waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  phone       text,
  source      text default 'site',
  user_agent  text,
  created_at  timestamptz not null default now()
);

create unique index if not exists hm_waitlist_email_key
  on public.hm_waitlist (lower(email));

alter table public.hm_waitlist enable row level security;

-- insert only. No select policy exists, so the list itself is unreadable to anon.
drop policy if exists hm_waitlist_anon_insert on public.hm_waitlist;
create policy hm_waitlist_anon_insert
  on public.hm_waitlist for insert to anon
  with check (true);

-- the counter the page displays: a real number, never a decorative one
create or replace function public.hm_waitlist_count()
returns bigint
language sql
security definer
stable
set search_path = public
as $$ select count(*) from public.hm_waitlist $$;

grant execute on function public.hm_waitlist_count() to anon;
