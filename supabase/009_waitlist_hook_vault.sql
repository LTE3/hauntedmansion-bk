-- Move the waitlist hook secret from a database setting into Vault.
--
-- Migration 008 read the shared secret from a custom parameter applied out of
-- band (alter database postgres set app.hm_hook_token = '...'). That is no
-- longer possible: Supabase revoked the privilege to set custom parameters,
-- and every form of it now fails with
--     42501: permission denied to set parameter "app.hm_hook_token"
-- even as the postgres role. The trigger was therefore permanently silent -
-- current_setting returned null, so it returned early and no confirmation
-- email was ever sent.
--
-- Vault is the supported replacement and is already installed. The secret is
-- stored encrypted, readable through vault.decrypted_secrets by the owner of
-- this security-definer function, and it is still not in this file - this repo
-- is public. It is written once, out of band:
--     select vault.create_secret('<token>', 'hm_hook_token', '...');
--
-- Behaviour is otherwise unchanged and deliberately unchanged: if the secret
-- is missing the trigger does nothing rather than firing an unauthenticated
-- request, because a signup must never fail over mail plumbing.

create or replace function public.hm_waitlist_welcome()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  tok text;
begin
  -- Already welcomed, or no address to welcome. Nothing to do. Checked before
  -- the Vault read so the common no-op path never touches the secret.
  if new.welcome_sent_at is not null or coalesce(new.email, '') = '' then
    return null;
  end if;

  select decrypted_secret into tok
    from vault.decrypted_secrets
   where name = 'hm_hook_token'
   limit 1;

  -- No secret configured: stay silent rather than issue a request the edge
  -- function will only reject with 403.
  if tok is null or tok = '' then
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
