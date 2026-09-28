-- Timed entry (owner, 2026-09-28). From October 8 every night sells by the
-- hour instead of by the night:
--
--   all ages   4:00, 5:00, 6:00, 7:00 PM
--   18+ only   8:00, 9:00, 10:00 PM
--
-- Each hour has its own ceiling. The night keeps its 500 as well, so the
-- two limits are checked together and neither can be passed. 71 a slot is
-- 500 split across seven hours, rounded down (497): an assumption, not the
-- owner's number - change the capacity column if he names one.
--
-- Opening weekend (Oct 1-4) keeps its own hours and is taken off online
-- sale: is_active = false, which hm-create-checkout already refuses with
-- not_on_sale. Orders already paid for those nights are untouched.
--
-- Orders from before this file have slot = null and stay valid for their
-- night, as they were sold.

begin;

create table if not exists public.hm_slots (
  event_date  date not null references public.hm_events(event_date),
  slot        time not null,
  adults_only boolean not null,
  capacity    integer not null check (capacity >= 0),
  sold        integer not null default 0 check (sold >= 0),
  primary key (event_date, slot),
  constraint hm_slots_not_oversold check (sold <= capacity)
);

alter table public.hm_orders add column if not exists slot time;

insert into public.hm_slots (event_date, slot, adults_only, capacity)
select e.event_date, s.slot, s.slot >= time '20:00', 71
  from public.hm_events e
 cross join (values (time '16:00'), (time '17:00'), (time '18:00'), (time '19:00'),
                    (time '20:00'), (time '21:00'), (time '22:00')) as s(slot)
 where e.event_date >= date '2026-10-08'
on conflict (event_date, slot) do nothing;

-- The night's own hours, as the owner gave them. last_entry is the last hour
-- anyone starts: an hour before close, because the walk-through is an hour.
update public.hm_events set doors = time '16:00', last_entry = time '22:00'
 where event_date >= date '2026-10-08';
update public.hm_events set doors = time '17:00', last_entry = time '22:00' where event_date in ('2026-10-01', '2026-10-02');
update public.hm_events set doors = time '16:00', last_entry = time '22:00' where event_date = '2026-10-03';
update public.hm_events set doors = time '12:00', last_entry = time '19:00' where event_date = '2026-10-04';
update public.hm_events set is_active = false where event_date between '2026-10-01' and '2026-10-04';

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

  -- The night is checked but not gated on is_active: a guest who reached
  -- Stripe before a night was switched off has paid and keeps the seat.
  update public.hm_events
     set sold = sold + o.tickets
   where event_date = o.event_date
     and sold + o.tickets <= capacity;
  get diagnostics n = row_count;

  if n > 0 and o.slot is not null then
    update public.hm_slots
       set sold = sold + o.tickets
     where event_date = o.event_date and slot = o.slot
       and sold + o.tickets <= capacity;
    get diagnostics n = row_count;
    if n = 0 then
      update public.hm_events set sold = sold - o.tickets where event_date = o.event_date;
    end if;
  end if;

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
  if o.slot is not null then
    update public.hm_slots set sold = greatest(0, sold - o.tickets)
     where event_date = o.event_date and slot = o.slot;
  end if;
  update public.hm_orders set status = p_status where id = o.id;
  return true;
end
$$;

-- What the page may know: which hours of which nights still have room.
-- Not how many - a yes or no per hour.
create or replace function public.hm_open_slots()
returns table (event_date date, slot time, adults_only boolean, open boolean)
language sql
stable
security definer
set search_path = public
as $$
  select s.event_date, s.slot, s.adults_only,
         e.is_active and s.sold < s.capacity and e.sold < e.capacity
    from public.hm_slots s
    join public.hm_events e using (event_date)
   order by s.event_date, s.slot
$$;

alter table public.hm_slots enable row level security;
revoke all on table public.hm_slots from public, anon, authenticated;
grant  all on table public.hm_slots to service_role;
revoke all on function public.hm_open_slots() from public;
grant execute on function public.hm_open_slots() to anon, authenticated, service_role;

commit;
