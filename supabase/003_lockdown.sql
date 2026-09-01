-- Take away everything the anonymous role was never supposed to have.
--
-- What was found on the live database on 2026-09-01, by asking the catalog
-- rather than by reading these files:
--
--   RLS on hm_waitlist            enabled
--   policies on hm_waitlist       exactly one, INSERT for anon, with check (true)
--   table grants to anon          SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--   table grants to authenticated INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--
-- Those grants are Supabase's defaults for the public schema, not something
-- anybody chose. Nothing was leaking, because a grant is only half of the
-- permission: with RLS on and no SELECT policy, a select returns zero rows no
-- matter what the grant says. The problem is that it leaves the whole list one
-- mistake away from public. Add a permissive select policy for any reason -
-- an admin view, a debugging session, a `for all using (true)` typed in the
-- dashboard at midnight - and every name, email and phone number becomes
-- readable by anyone who opens the page source and copies the anon key, which
-- is published by design.
--
-- TRUNCATE is worse than one mistake away. Row level security governs SELECT,
-- INSERT, UPDATE and DELETE. It does not govern TRUNCATE - a role holding that
-- privilege can empty the table and no policy will stop it. It was granted to
-- anon. Nothing in PostgREST routes to TRUNCATE today, so this was not
-- exploitable through the front door, but a privilege that can destroy the
-- entire list and cannot be restrained by policy has no business being held by
-- a role whose credentials are printed on the website.
--
-- TRIGGER is the same shape of problem: it lets the grantee attach a function
-- of their choosing to a table they cannot otherwise write.
--
-- So: revoke the lot, then hand back precisely the four columns the form
-- posts. After this, the anonymous key can do exactly two things - add a row
-- with those four columns, and ask for the count through the security-definer
-- function. Everything else fails on privileges, before RLS is ever consulted,
-- which means a future policy mistake cannot open a door that no longer has a
-- doorway.

begin;

-- 1. Everything back.
revoke all on public.hm_waitlist from anon, authenticated;

-- Deliberately NOT touching `alter default privileges in schema public`. It
-- would harden every table created here in future, but its blast radius is the
-- whole schema and every other thing that might ever live in this project,
-- which is a bigger decision than one waitlist table gets to make. This file
-- changes exactly one table.

-- 2. Exactly what the form sends, and nothing else. Column-level, so an insert
--    naming any other column - id, source, created_at - is refused outright
--    rather than silently accepted and defaulted.
grant insert (name, email, phone, user_agent) on public.hm_waitlist to anon;

-- 3. The counter stays. It is security definer, so it reads the table with the
--    function owner's rights rather than the caller's, which is the whole
--    reason a visitor can be shown a real number while being unable to read a
--    single row behind it.
grant execute on function public.hm_waitlist_count() to anon;

-- 4. The insert policy is unchanged and still `with check (true)`. It has to
--    be: the point of the form is that a stranger can add themselves, and
--    there is no session to test the row against. The column grant above is
--    what bounds it, together with the length and format constraints in 002.

commit;

-- Verification, to be run after this and expected to return exactly these rows:
--
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name = 'hm_waitlist' and grantee in ('anon','authenticated');
--   -> zero rows   (the INSERT is column-level and appears in
--                   information_schema.column_privileges instead)
--
--   select grantee, column_name, privilege_type
--     from information_schema.column_privileges
--    where table_name = 'hm_waitlist' and grantee = 'anon';
--   -> four rows, INSERT on name, email, phone, user_agent
