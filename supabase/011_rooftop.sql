-- The Graveyard - Hidden Rooftop: free table reservations (owner, 2026-10-08).
--
-- A reservation is a promise of a table, not a sale: no Stripe, pay at the
-- bar. Open on the nights the house is open, on the hour from 6 PM to the
-- night's last entry. Tables are unlimited for now, so nothing here counts
-- seats; a cap can be added later without touching the rows.
--
-- Written only by the hm-rooftop edge function (service role). RLS is on
-- with no policies, so the anon key the site carries can neither read nor
-- write it - reservations hold names, emails and phone numbers.

create table if not exists public.hm_rooftop_reservations (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  event_date  date not null references public.hm_events(event_date),
  slot        time not null,
  party       int  not null check (party between 1 and 6),
  name        text not null check (length(name) between 1 and 80),
  email       text not null check (length(email) <= 254),
  phone       text check (phone is null or length(phone) <= 32),
  ticket_code text,
  status      text not null default 'booked' check (status in ('booked', 'cancelled')),
  email_sent_at timestamptz,
  email_error text,
  created_at  timestamptz not null default now()
);
create index if not exists hm_rooftop_reservations_night on public.hm_rooftop_reservations (event_date, slot);
alter table public.hm_rooftop_reservations enable row level security;
revoke all on public.hm_rooftop_reservations from anon, authenticated;

-- The rooftop promo email goes out once per paid order, after the ticket.
alter table public.hm_orders add column if not exists rooftop_email_sent_at timestamptz;
