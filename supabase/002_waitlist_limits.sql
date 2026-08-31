-- Server-side limits on an insert that anyone can call.
--
-- The anon key is in the page source, which is the correct place for it, and
-- the insert policy is `with check (true)`. Everything that stops a bad row
-- today runs in the browser: a maxlength attribute and a regex. Neither of
-- those exists for anything that is not a browser, and the endpoint, the key
-- and the table name are all public.
--
-- Nothing here can reject a row the page itself would send. Every limit is
-- either the exact maxlength the form already enforces or the exact regex it
-- already tests, which is what makes these safe to add to a live table: the
-- only submissions they can turn away are ones no visitor could have made.

-- ---------------------------------------------------------------------------
-- 1. Only the four columns the form actually sends.
--
-- The table-level grant let an anon caller set every column, including id,
-- source and created_at - so a script could forge ids, mislabel where a row
-- came from, or backdate rows to sit above the real ones in an export. All
-- four clients (index.html and the fifteen v/ pages, via v/waitlist.js) post
-- exactly {name, email, phone, user_agent} and nothing else.
revoke insert on public.hm_waitlist from anon;
grant insert (name, email, phone, user_agent) on public.hm_waitlist to anon;

-- ---------------------------------------------------------------------------
-- 2. Sizes. These mirror the form's maxlength attributes exactly.
--
-- Every column is unbounded text, so a paste - or a loop - of any size is
-- accepted and stored today.
alter table public.hm_waitlist
  drop constraint if exists hm_waitlist_name_len,
  add  constraint hm_waitlist_name_len  check (char_length(name)  <= 120),
  drop constraint if exists hm_waitlist_email_len,
  add  constraint hm_waitlist_email_len check (char_length(email) between 3 and 254),
  drop constraint if exists hm_waitlist_phone_len,
  add  constraint hm_waitlist_phone_len check (char_length(phone) <= 40);

-- user_agent is written by the client and never shown to anyone, so it is the
-- easiest column to stuff. 1024 is far above any real browser's string - the
-- longest in the wild run a little over 300 characters - and far below a
-- payload worth sending.
alter table public.hm_waitlist
  drop constraint if exists hm_waitlist_ua_len,
  add  constraint hm_waitlist_ua_len check (char_length(user_agent) <= 1024);

-- ---------------------------------------------------------------------------
-- 3. Shape. The same test the form runs, so it turns away nothing the form
-- would have let through: a local part, an @, a domain with a dot in it.
alter table public.hm_waitlist
  drop constraint if exists hm_waitlist_email_shape,
  add  constraint hm_waitlist_email_shape
    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$');

-- ---------------------------------------------------------------------------
-- NOT APPLIED: a per-IP rate limit.
--
-- The obvious next step is a BEFORE INSERT trigger counting recent rows from
-- current_setting('request.headers')::json->>'x-forwarded-for'. It is left
-- here unapplied on purpose, because its failure mode points the wrong way.
-- A shared network - a venue, a dorm, a carrier-grade NAT - presents one
-- address for everyone behind it, so any threshold low enough to stop a script
-- is low enough to turn away real people standing next to each other, and the
-- page would tell them they had signed up when it had written nothing. The
-- unique index on lower(email) already forces a flood to invent a fresh
-- address per row, and the limits above cap what each row can weigh.
--
-- If it is wanted later, the honest version is generous and observable rather
-- than tight and silent:
--
--   create or replace function public.hm_waitlist_throttle()
--   returns trigger language plpgsql security definer set search_path = public as $$
--   declare ip text := split_part(
--     coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for',''), ',', 1);
--   begin
--     if ip <> '' and (select count(*) from public.hm_waitlist
--                      where ip_hash = md5(ip) and created_at > now() - interval '1 hour') >= 30
--     then raise exception 'rate limited' using errcode = '54000'; end if;
--     new.ip_hash := md5(ip);
--     return new;
--   end $$;
--
-- which needs an ip_hash column, a real decision about what the page shows
-- when it fires, and a number chosen against expected launch-night traffic.
