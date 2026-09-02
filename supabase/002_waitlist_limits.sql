-- Server-side limits on an insert that anyone can call.
--
-- The anon key is in the page source, which is the correct place for it, and
-- the insert policy is `with check (true)`. Everything that stops a bad row
-- today runs in the browser: a maxlength attribute and a regex. Neither of
-- those exists for anything that is not a browser, and the endpoint, the key
-- and the table name are all public.
--
-- Most of what follows mirrors the form exactly - the same maxlength, the same
-- regex - so it can only turn away submissions no visitor could have made.
-- Two limits do not mirror anything, and it is worth being straight about
-- which: the 1024 on user_agent has no counterpart in the form at all, and the
-- lower bound of 3 on email is a floor the form never tests. Both are set far
-- outside the range a real browser produces, but "no form equivalent" and
-- "cannot reject a real visitor" are different claims, and only the first one
-- is provable by reading this file.

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
-- SUPERSEDED: the per-IP rate limit this file declined to write.
--
-- This section used to argue against a per-IP throttle, on the grounds that a
-- shared network - a venue, a dorm, a carrier-grade NAT - presents one address
-- for everyone behind it, so any threshold low enough to stop a script would
-- also turn away real people standing next to each other.
--
-- 004_rate_limit.sql applied one anyway, because the argument was answered
-- rather than ignored:
--
--   * The threshold is 40 inserts per ten minutes, not the 30-per-hour this
--     section used to sketch. That is generous enough for a crowded room and
--     still cheap enough that a script gets nowhere.
--   * It is not silent. The trigger raises SQLSTATE 53400, and index.html
--     tells that apart from a network failure so it can stop saying "try
--     again" to the one person for whom trying again is guaranteed to fail.
--   * It stores no address. That sketch wrote md5(ip) into a permanent
--     ip_hash column on the waitlist itself, which is a visitor log with extra
--     steps and an unsalted one at that. The applied version keeps a salted
--     SHA-256 in a separate table, deletes it ten minutes later, and never
--     attaches it to the signup.
--
-- Read 004_rate_limit.sql for what is actually on the database. The remaining
-- true statements from this section: the unique index on lower(email) still
-- forces a flood to invent a fresh address per row, and the limits above still
-- cap what each row can weigh.
