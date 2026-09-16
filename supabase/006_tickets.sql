-- Tickets: the nights, what is sold, and each order, with the counting done
-- in one place so two people buying the last pair at once cannot both get it.
--
-- Why these are hm_ tables and not rows in the existing events/bookings
-- tables: events.event_date is unique across that table and La Casita runs
-- its own Friday and Saturday nights in October, so a haunt row for the same
-- date is impossible there; and the increment_sold function the earlier plan
-- meant to reuse does not exist in this database (checked 2026-09-16). The
-- haunt keeps its own three tables and its own counter.
--
-- The shape:
--
--   * hm_events    one row per night: capacity, sold, doors, last entry;
--   * hm_products  what can be bought: one ticket, two tickets, four
--                  tickets; how many people each admits and the price;
--   * hm_orders    one row per Stripe Checkout Session, from pending to
--                  paid (or expired, or oversold, or refunded), carrying the
--                  ticket code the door scans.
--
-- Counting: hm_confirm_order() is the only thing that moves hm_events.sold
-- upward, it runs as one statement under a row lock, and it refuses to pass
-- capacity. Stripe retries a webhook it did not get a 2xx for, so the same
-- session can arrive twice: the order row is locked and checked before any
-- increment, and a second arrival returns 'already' and changes nothing.
--
-- Nothing here is reachable by the anonymous key except hm_nights(), which
-- returns per-night totals and no personal data. Everything else is RLS on,
-- no policies, every grant revoked, the same posture as 003, 004 and 005.
-- The street address of the venue is not in this file or this database; it
-- lives in an edge-function secret and appears only in the ticket email.

begin;

-- ---------------------------------------------------------------------------
-- 1. The nights.
create table if not exists public.hm_events (
  event_date  date primary key,
  doors       time not null,
  last_entry  time not null,
  capacity    integer not null check (capacity >= 0),
  sold        integer not null default 0 check (sold >= 0),
  is_active   boolean not null default false,
  note        text,
  created_at  timestamptz not null default now(),
  constraint hm_events_not_oversold check (sold <= capacity)
);

-- ---------------------------------------------------------------------------
-- 2. What can be bought. Price in cents. tickets = people admitted.
create table if not exists public.hm_products (
  code        text primary key,
  label       text not null,
  tickets     integer not null check (tickets between 1 and 6),
  cents       integer not null check (cents > 0),
  is_active   boolean not null default true,
  sort        integer not null default 0
);

-- ---------------------------------------------------------------------------
-- 3. Orders. One per Checkout Session. livemode is Stripe's own flag, kept so
--    test-mode orders can never be mistaken for money.
create table if not exists public.hm_orders (
  id                    uuid primary key default gen_random_uuid(),
  stripe_session_id     text not null unique,
  stripe_payment_intent text,
  stripe_event_id       text,
  livemode              boolean,
  event_date            date not null references public.hm_events(event_date),
  product               text not null references public.hm_products(code),
  tickets               integer not null check (tickets between 1 and 6),
  amount_cents          integer not null check (amount_cents >= 0),
  email                 text,
  name                  text,
  tag                   text,
  status                text not null default 'pending'
                        check (status in ('pending','paid','oversold','expired','refunded')),
  ticket_code           text unique,
  created_at            timestamptz not null default now(),
  paid_at               timestamptz,
  expired_at            timestamptz,
  email_sent_at         timestamptz,
  email_error           text,
  scanned_at            timestamptz,
  scanned_by            text
);
create index if not exists hm_orders_event_status on public.hm_orders(event_date, status);
create index if not exists hm_orders_email on public.hm_orders(lower(email));

-- ---------------------------------------------------------------------------
-- 4. The counter. Called by the webhook, as the service role, once per Stripe
--    event. Returns exactly one of:
--      'paid'      counted, ticket_code set;
--      'already'   this session was processed before, nothing changed;
--      'oversold'  the night filled between checkout and payment; the order
--                  is marked so a human refunds it, and sold did not move;
--      'unknown'   no order row for this session (the caller inserts one
--                  from the session's metadata and calls again).
create or replace function public.hm_confirm_order(
  p_session_id     text,
  p_event_id       text,
  p_payment_intent text,
  p_livemode       boolean,
  p_email          text,
  p_name           text,
  p_amount_cents   integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  o    public.hm_orders%rowtype;
  code text;
  n    integer;
begin
  select * into o from public.hm_orders where stripe_session_id = p_session_id for update;
  if not found then
    return 'unknown';
  end if;
  if o.status <> 'pending' then
    return 'already';
  end if;

  -- One statement, one row lock: the guard and the increment cannot be split.
  update public.hm_events
     set sold = sold + o.tickets
   where event_date = o.event_date
     and is_active
     and sold + o.tickets <= capacity;
  get diagnostics n = row_count;

  if n = 0 then
    update public.hm_orders
       set status = 'oversold', stripe_event_id = p_event_id,
           stripe_payment_intent = coalesce(p_payment_intent, stripe_payment_intent),
           livemode = coalesce(p_livemode, livemode),
           email = coalesce(p_email, email), name = coalesce(p_name, name),
           amount_cents = coalesce(p_amount_cents, amount_cents),
           paid_at = now()
     where id = o.id;
    return 'oversold';
  end if;

  -- A code the door can read aloud: HM- and eight hex characters, cut from a
  -- random uuid (built in; pgcrypto lives outside this search_path). Unique
  -- by constraint; the loop is for the day two collide.
  loop
    code := 'HM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.hm_orders where ticket_code = code);
  end loop;

  update public.hm_orders
     set status = 'paid', ticket_code = code, stripe_event_id = p_event_id,
         stripe_payment_intent = coalesce(p_payment_intent, stripe_payment_intent),
         livemode = coalesce(p_livemode, livemode),
         email = coalesce(p_email, email), name = coalesce(p_name, name),
         amount_cents = coalesce(p_amount_cents, amount_cents),
         paid_at = now()
   where id = o.id;
  return 'paid';
end
$$;

-- A refund or a cancelled paid order gives its seats back. Service role only.
create or replace function public.hm_release_order(p_session_id text, p_status text default 'refunded')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.hm_orders%rowtype;
begin
  select * into o from public.hm_orders where stripe_session_id = p_session_id for update;
  if not found or o.status <> 'paid' then
    return false;
  end if;
  update public.hm_events set sold = greatest(0, sold - o.tickets) where event_date = o.event_date;
  update public.hm_orders set status = p_status where id = o.id;
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. What the page may see: per-night totals, nothing about anyone.
create or replace function public.hm_nights()
returns table (event_date date, doors time, last_entry time, capacity integer, sold integer, is_active boolean)
language sql
stable
security definer
set search_path = public
as $$
  select event_date, doors, last_entry, capacity, sold, is_active
    from public.hm_events
   order by event_date
$$;

create or replace function public.hm_catalogue()
returns table (code text, label text, tickets integer, cents integer)
language sql
stable
security definer
set search_path = public
as $$
  select code, label, tickets, cents
    from public.hm_products
   where is_active
   order by sort, cents
$$;

-- ---------------------------------------------------------------------------
-- 6. Lockdown.
alter table public.hm_events   enable row level security;
alter table public.hm_products enable row level security;
alter table public.hm_orders   enable row level security;
revoke all on table public.hm_events, public.hm_products, public.hm_orders from public, anon, authenticated;
grant  all on table public.hm_events, public.hm_products, public.hm_orders to service_role;

revoke all on function public.hm_confirm_order(text, text, text, boolean, text, text, integer) from public, anon, authenticated;
grant execute on function public.hm_confirm_order(text, text, text, boolean, text, text, integer) to service_role;
revoke all on function public.hm_release_order(text, text) from public, anon, authenticated;
grant execute on function public.hm_release_order(text, text) to service_role;

grant execute on function public.hm_nights()    to anon, authenticated, service_role;
grant execute on function public.hm_catalogue() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. The nineteen nights, from nights.html: October 1 opens, then Thursday to
--    Sunday every week. Doors and last entry from faq.html. Capacity is the
--    LIKELY scenario from .claude/ops/box-office/capacity.md (48 guests an
--    hour), a placeholder until the owner supplies the real number; every
--    night is inactive until then, so nothing can be sold against a guess.
insert into public.hm_events (event_date, doors, last_entry, capacity, is_active, note)
select d::date,
       time '17:00',
       case when extract(isodow from d) in (5, 6) then time '21:00' else time '22:15' end,
       case when extract(isodow from d) in (5, 6) then 192 else 252 end,
       false,
       'capacity = SCENARIO 48/hr, not the owner''s number'
  from generate_series(date '2026-10-01', date '2026-10-31', interval '1 day') d
 where extract(isodow from d) in (4, 5, 6, 7)
on conflict (event_date) do nothing;

-- The owner's prices, 2026-09-16, by voice: "twenty dollar tickets", "groups
-- of two for thirty five". The four-ticket price was left open ("not sixty"),
-- so it is not here until it is named.
insert into public.hm_products (code, label, tickets, cents, is_active, sort) values
  ('single', 'One ticket',  1, 2000, true, 1),
  ('pair',   'Two tickets', 2, 3500, true, 2)
on conflict (code) do nothing;

commit;
