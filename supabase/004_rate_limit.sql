-- Throttle the one endpoint a stranger is allowed to reach.
--
-- After 003 the anonymous key can do exactly two things: insert four columns,
-- and ask for the count. That is a small door, but it is an unlimited one - a
-- script can post distinct addresses as fast as the network allows and fill
-- the list with names nobody will ever email. Nothing is stolen by that; the
-- list is simply ruined, and ruining it costs the attacker nothing.
--
-- The obvious fix - cap inserts per minute across the whole table - is worse
-- than the problem. A global cap throttles exactly the traffic this page
-- exists to catch: the night the post goes around and four hundred people
-- sign up in ten minutes is the night the cap turns them away. A limit is only
-- safe if it can tell one caller from another.
--
-- It can. PostgREST publishes the request headers to the database as a GUC,
-- and on this platform they arrive with the client address in
-- cf-connecting-ip, set by the edge and not settable by the caller.
-- Probed on the live project on 2026-09-01 before any of this was written;
-- x-forwarded-for carries the same value but a client can prepend to it, so it
-- is only the fallback.
--
-- What is stored: not the address. A SHA-256 of the address and a secret salt,
-- for ten minutes. That is enough to count a repeat caller and not enough to
-- work backwards to a person - and the row is deleted on the next insert after
-- its window closes, so the table holds only whoever is signing up right now.
--
-- Forty in ten minutes, per address. A person signs up once. A shared office
-- or a phone network behind one address would have to send forty in ten
-- minutes to notice this exists. A script gets 5,760 a day instead of as many
-- as it likes, and has to find new addresses to do better.

begin;

-- 1. The salt. One row, generated here, never leaves the database. Without it
--    the stored hash would be a hash of a 32-bit number, which is to say the
--    address itself with extra steps.
create table if not exists public.hm_throttle_salt (
  id    boolean primary key default true check (id),
  salt  bytea   not null default extensions.gen_random_bytes(32)
);
insert into public.hm_throttle_salt (id) values (true) on conflict (id) do nothing;

-- 2. The counter. No grants to anon or authenticated, so PostgREST refuses it
--    on privileges; RLS on as well, so a future grant still finds no policy.
create table if not exists public.hm_signup_throttle (
  ip_hash      bytea primary key,
  n            integer     not null default 0,
  window_start timestamptz not null default now()
);

alter table public.hm_throttle_salt   enable row level security;
alter table public.hm_signup_throttle enable row level security;
revoke all on public.hm_throttle_salt   from anon, authenticated;
revoke all on public.hm_signup_throttle from anon, authenticated;

-- 3. The trigger. Security definer, because the caller is anon and anon has no
--    business reading the salt or the counter directly. search_path is pinned:
--    a definer function that resolves its own function names through the
--    caller's search_path is how a definer function becomes a privilege
--    escalation.
create or replace function public.hm_waitlist_throttle()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  hdrs jsonb;
  ip   text;
  h    bytea;
  cur  integer;
begin
  hdrs := coalesce(nullif(current_setting('request.headers', true), '')::jsonb,
                   '{}'::jsonb);

  -- cf-connecting-ip is written by the edge and overwritten on every request,
  -- so a caller cannot set it. x-forwarded-for can be prepended to by the
  -- caller, which is why it is only the fallback and why the first element is
  -- the one taken.
  ip := coalesce(nullif(hdrs->>'cf-connecting-ip', ''),
                 nullif(btrim(split_part(hdrs->>'x-forwarded-for', ',', 1)), ''));

  -- No headers means this insert did not come through the API - a migration,
  -- the dashboard, a psql session. Those are already authenticated as somebody
  -- with real privileges and are not what this is for.
  if ip is null then
    return new;
  end if;

  h := extensions.digest(ip || encode((select salt from public.hm_throttle_salt), 'hex'),
                         'sha256');

  -- Closed windows are dropped rather than aged in place, so the table stays
  -- the size of the traffic in the last ten minutes rather than the size of
  -- everyone who ever signed up.
  delete from public.hm_signup_throttle
   where window_start < now() - interval '10 minutes';

  insert into public.hm_signup_throttle as t (ip_hash, n, window_start)
       values (h, 1, now())
  on conflict (ip_hash) do update
       set n = case when t.window_start < now() - interval '10 minutes'
                    then 1 else t.n + 1 end,
           window_start = case when t.window_start < now() - interval '10 minutes'
                    then now() else t.window_start end
    returning t.n into cur;

  if cur > 40 then
    -- 53400 is configuration_limit_exceeded, which PostgREST returns as 500.
    -- The message is deliberately plain: it is shown to whoever tripped it,
    -- and it should read as a speed bump rather than as a description of the
    -- limit they just found.
    raise exception 'Too many signups from this connection. Try again shortly.'
      using errcode = '53400';
  end if;

  return new;
end
$fn$;

-- The raise rolls the whole statement back, the counter increment with it, so a
-- blocked caller leaves the count sitting at the threshold rather than climbing
-- forever. Every further attempt inside the window increments to 41, trips, and
-- rolls back again - still refused, and the window still expires on schedule.

drop trigger if exists hm_waitlist_throttle on public.hm_waitlist;
create trigger hm_waitlist_throttle
  before insert on public.hm_waitlist
  for each row execute function public.hm_waitlist_throttle();

commit;
