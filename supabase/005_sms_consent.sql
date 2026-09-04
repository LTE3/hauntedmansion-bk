-- Consent, opt-out and a send log, so that texting the waitlist can be done
-- lawfully and shown to have been.
--
-- What the law asks (TCPA, 47 U.S.C. 227, the FCC's rules under it, and the
-- 2024 revocation order in force since April 2025): prior express written
-- consent before any marketing text; a clear disclosure at the point where
-- the number is collected; a way to stop that is easy, honoured promptly, and
-- accepted in any reasonable wording; and records of all of it. The pages
-- already show the disclosure and store a number only when the box under it
-- is ticked - index.html since it went live, and every v/ page through
-- v/waitlist.js as of this change. Before this file the database kept the
-- number and nothing else: no time, no text, no way to mark a STOP.
--
-- After it:
--
--   * a number that arrives is normalised to +1XXXXXXXXXX and stamped with
--     the server's clock and the version of the disclosure that was on
--     screen, by a trigger, so no client can write a number without a
--     consent record or backdate one;
--   * a number that texts STOP lands in hm_sms_optout, and the stamp is
--     copied onto every waitlist row with that number, so a sender that
--     forgets to check the opt-out table still cannot miss it;
--   * every inbound text and every outbound attempt is logged, which is the
--     proof if anyone ever asks;
--   * hm_sms_recipients() is the one definition of "who may be texted", and
--     only the service role - the edge functions - can call it.
--
-- Nothing here is reachable by the anonymous key. New tables have RLS on
-- with no policies and every grant revoked, the same posture as 003 and 004.

begin;

-- ---------------------------------------------------------------------------
-- 1. Normaliser. A US or Canadian number in any of the usual shapes becomes
--    E.164; anything else becomes null, because a number that cannot be
--    dialled is not worth keeping and a number kept in three formats is three
--    numbers to the opt-out check. Immutable, so an index could use it.
--
--    Deliberately left executable by PUBLIC: the insert trigger below runs
--    with the caller's rights, and the caller is anon.
create or replace function public.hm_e164(raw text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select case
           when length(d) = 10                          then '+1' || d
           when length(d) = 11 and left(d, 1) = '1'     then '+'  || d
           else null
         end
    from (select regexp_replace(raw, '\D', '', 'g') as d) s
$$;

-- ---------------------------------------------------------------------------
-- 2. The consent record, on the waitlist row itself.
alter table public.hm_waitlist
  add column if not exists sms_consent_at   timestamptz,
  add column if not exists sms_consent_text text,
  add column if not exists sms_opted_out_at timestamptz;

-- The exact words that were on screen, by version, so a stamp of
-- 'hm-sms-v1' on a row can always be turned back into the sentence the
-- person ticked. Change the words on the page: add a row, bump the version
-- in the trigger.
create table if not exists public.hm_sms_consent_text (
  version text primary key,
  body    text not null,
  since   timestamptz not null default now()
);
alter table public.hm_sms_consent_text enable row level security;
revoke all on public.hm_sms_consent_text from anon, authenticated;

insert into public.hm_sms_consent_text (version, body) values (
  'hm-sms-v1',
  'Text me when the house opens. Recurring automated marketing texts from '
  'Pulse Ticketing LLC at the number above — opening night and ticket '
  'on-sales. Frequency varies. Message and data rates may apply. Not a '
  'condition of entry or of any purchase. Reply STOP to stop, HELP for help. '
  'Leave this unticked and your number is not kept.'
) on conflict (version) do nothing;

-- Before insert: normalise, and stamp. The client posts only the four
-- columns it is allowed to (003); the trigger fills in the rest from the
-- server's own clock, which is what makes the stamp worth something.
create or replace function public.hm_waitlist_sms_consent()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.phone is null or btrim(new.phone) = '' then
    new.phone := null;
    return new;
  end if;
  new.phone := public.hm_e164(new.phone);
  if new.phone is null then
    -- Not a number we could text. Keeping it would be keeping a string we
    -- cannot use and cannot honour an opt-out for.
    return new;
  end if;
  new.sms_consent_at   := now();
  new.sms_consent_text := 'hm-sms-v1';
  return new;
end
$fn$;

drop trigger if exists hm_waitlist_sms_consent on public.hm_waitlist;
create trigger hm_waitlist_sms_consent
  before insert on public.hm_waitlist
  for each row execute function public.hm_waitlist_sms_consent();

-- Rows from before this file: normalise the number, keep it if it will not
-- normalise, and stamp nothing. A consent record that was written after the
-- fact by a migration is not a consent record. Those rows are therefore not
-- in hm_sms_recipients() until someone who knows how each number was
-- collected sets sms_consent_at deliberately.
update public.hm_waitlist
   set phone = coalesce(public.hm_e164(phone), phone)
 where phone is not null;

-- ---------------------------------------------------------------------------
-- 3. Opt-outs. Keyed on the number, not the row: a person who texts STOP has
--    stopped, whichever signup their number sits on and however many.
create table if not exists public.hm_sms_optout (
  phone text primary key check (phone ~ '^\+1[0-9]{10}$'),
  at    timestamptz not null default now(),
  via   text not null default 'stop',   -- 'stop' (inbound keyword), 'twilio-21610' (carrier block seen on send), 'manual'
  body  text                            -- what they wrote, when there was something
);
alter table public.hm_sms_optout enable row level security;
revoke all on public.hm_sms_optout from anon, authenticated;

-- Mirror the stamp onto the waitlist rows, both ways, so the row and the
-- table can never disagree about whether a number may be texted.
create or replace function public.hm_sms_optout_mirror()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    update public.hm_waitlist
       set sms_opted_out_at = coalesce(sms_opted_out_at, new.at)
     where phone = new.phone;
    return new;
  else
    update public.hm_waitlist
       set sms_opted_out_at = null
     where phone = old.phone;
    return old;
  end if;
end
$fn$;
revoke execute on function public.hm_sms_optout_mirror() from public, anon, authenticated;

drop trigger if exists hm_sms_optout_mirror on public.hm_sms_optout;
create trigger hm_sms_optout_mirror
  after insert or delete on public.hm_sms_optout
  for each row execute function public.hm_sms_optout_mirror();

-- ---------------------------------------------------------------------------
-- 4. Logs. Inbound: every text the number receives, keyword or not, because
--    the FCC's revocation rule counts any reasonable wording and a human has
--    to be able to read what did not match a keyword. Outbound: every
--    attempt, with Twilio's answer, one row per number per blast - which is
--    also what makes a blast safe to resume after a timeout.
create table if not exists public.hm_sms_inbound (
  id          bigint generated always as identity primary key,
  from_phone  text,
  to_phone    text,
  body        text,
  keyword     text,                     -- 'stop' | 'start' | 'help' | null
  twilio_sid  text,
  at          timestamptz not null default now()
);
alter table public.hm_sms_inbound enable row level security;
revoke all on public.hm_sms_inbound from anon, authenticated;

create table if not exists public.hm_sms_log (
  id          bigint generated always as identity primary key,
  blast_id    uuid not null,
  phone       text not null,
  body        text not null,
  twilio_sid  text,
  status      text not null,            -- 'queued' | 'sent' | 'failed' | 'skipped-optout'
  error       text,
  at          timestamptz not null default now(),
  unique (blast_id, phone)
);
alter table public.hm_sms_log enable row level security;
revoke all on public.hm_sms_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Who may be texted. One place, so the sender cannot get it half right:
--    a dialable number, a consent stamp, no opt-out on the row and none in
--    the table. Callable by the service role and nobody else; functions are
--    executable by PUBLIC unless told otherwise, so it is told.
create or replace function public.hm_sms_recipients()
returns table (phone text)
language sql
stable
set search_path = public
as $$
  select distinct w.phone
    from public.hm_waitlist w
   where w.phone ~ '^\+1[0-9]{10}$'
     and w.sms_consent_at   is not null
     and w.sms_opted_out_at is null
     and not exists (select 1 from public.hm_sms_optout o where o.phone = w.phone)
   order by 1
$$;
revoke execute on function public.hm_sms_recipients() from public, anon, authenticated;
grant  execute on function public.hm_sms_recipients() to service_role;

commit;

-- Verification, expected after this runs:
--
--   select count(*) from information_schema.role_table_grants
--    where table_name in ('hm_sms_optout','hm_sms_inbound','hm_sms_log','hm_sms_consent_text')
--      and grantee in ('anon','authenticated');
--   -> 0
--
--   select column_name from information_schema.column_privileges
--    where table_name = 'hm_waitlist' and grantee = 'anon' order by 1;
--   -> email, name, phone, user_agent   (unchanged from 003)
--
--   select tgname from pg_trigger where tgrelid = 'public.hm_waitlist'::regclass and not tgisinternal;
--   -> hm_waitlist_sms_consent, hm_waitlist_throttle
--
--   select count(*) filter (where phone is not null) as with_phone,
--          count(*) filter (where sms_consent_at is not null) as stamped
--     from public.hm_waitlist;
--   -> stamped = 0 immediately after; it grows only from new signups.
