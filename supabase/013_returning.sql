-- Returning guests (owner, 2026-10-21): an apology for opening weekend, with
-- a $20 ticket for anyone who wants to come back. Not on sale to the public.
--
-- Each invited guest gets one random token, sent only in their own email.
-- The token lets them buy up to max_tickets $20 tickets (as many as they
-- originally bought, capped at six) through hm-create-checkout, which counts
-- what that token has already paid for (hm_orders.tag = 'ret-' || token).
--
-- RLS on, no policies: only the edge functions (service role) read it.

create table if not exists public.hm_return_invites (
  token       text primary key check (token ~ '^[a-f0-9]{16}$'),
  email       text not null check (length(email) <= 254),
  name        text check (name is null or length(name) <= 80),
  max_tickets int  not null check (max_tickets between 1 and 6),
  created_at  timestamptz not null default now()
);
alter table public.hm_return_invites enable row level security;
revoke all on public.hm_return_invites from anon, authenticated;

-- $18 a ticket + the $2/ticket processing fee = $20 a ticket at checkout.
-- One product per count, because a product is a fixed number of tickets.
insert into public.hm_products (code, label, tickets, cents, is_active) values
  ('ret_one',   'Returning guest · 1 ticket',  1, 1800, true),
  ('ret_two',   'Returning guest · 2 tickets', 2, 3600, true),
  ('ret_three', 'Returning guest · 3 tickets', 3, 5400, true),
  ('ret_four',  'Returning guest · 4 tickets', 4, 7200, true),
  ('ret_five',  'Returning guest · 5 tickets', 5, 9000, true),
  ('ret_six',   'Returning guest · 6 tickets', 6, 10800, true)
on conflict (code) do nothing;
