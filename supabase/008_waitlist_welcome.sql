-- Waitlist confirmation email, sent once per signup.
--
-- The signup is a direct PostgREST insert from the browser, so there is no
-- server step to hang a send off. The database makes the call itself, AFTER
-- INSERT, over pg_net. Two consequences worth stating plainly:
--
--   * The insert has already committed when this fires. A mail outage can
--     never cost the owner a name - the row is the record, the email is a
--     courtesy layered on top.
--   * pg_net is asynchronous, so the guest's "Enter the waitlist" button is
--     not waiting on Gmail. Signup stays as fast as it is today.
--
-- The shared secret is NOT in this file. This repo is public. The trigger
-- reads it from a database setting applied out of band:
--     alter database postgres set app.hm_hook_token = '<token>';
-- If that setting is missing the trigger does nothing at all rather than
-- firing an unauthenticated request.

create extension if not exists pg_net with schema extensions;

alter table public.hm_waitlist
  add column if not exists welcome_sent_at timestamptz;

comment on column public.hm_waitlist.welcome_sent_at is
  'When the confirmation email was accepted by SMTP. Null means never sent, '
  'which is what makes a retry safe: the edge function stamps this only on '
  'success, so an unstamped row is always eligible and a stamped row is '
  'never sent twice.';

create or replace function public.hm_waitlist_welcome()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tok text := current_setting('app.hm_hook_token', true);
begin
  -- No token configured: stay silent rather than issue a request that the
  -- function will only reject. Signup must never fail because mail is not
  -- wired up yet.
  if tok is null or tok = '' then
    return null;
  end if;

  -- Already welcomed, or no address to welcome. Nothing to do.
  if new.welcome_sent_at is not null or coalesce(new.email, '') = '' then
    return null;
  end if;

  perform net.http_post(
    url     := 'https://tqeunmqnaoyrerkbhokk.supabase.co/functions/v1/hm-waitlist-welcome',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-hm-hook',    tok
               ),
    body    := jsonb_build_object(
                 'id',    new.id,
                 'name',  new.name,
                 'email', new.email
               ),
    timeout_milliseconds := 8000
  );
  return null;
end;
$$;

drop trigger if exists hm_waitlist_welcome on public.hm_waitlist;
create trigger hm_waitlist_welcome
  after insert on public.hm_waitlist
  for each row
  execute function public.hm_waitlist_welcome();
