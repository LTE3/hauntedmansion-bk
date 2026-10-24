-- The Graveyard line (owner, 2026-10-24). Guests wait at The Graveyard
-- (Don Rique's) and are sent across to the house in groups of 15.
--
-- Staff check a ticket in when its party arrives at The Graveyard. Parties
-- go in order of their ticketed entry time, then of arrival, and a party is
-- never split. A party that checks in more than 10 minutes after its entry
-- time is pushed to the next half-hour session (owner, 2026-10-24): the
-- order key is hm_queue_eff(), not the ticket's slot.
--
-- Pressing "call next group" takes waiting parties from the front until 15
-- people, skipping a party that would overflow the group (it stays at the
-- front for the next one). A called party that does not show is put back,
-- which counts as checking in again now - so it lands behind the people
-- who are on time.
--
-- Only hm-queue (service role) touches any of this.

create table if not exists public.hm_queue (
  ticket_code   text primary key references public.hm_orders(ticket_code),
  event_date    date not null,
  party         int not null check (party between 1 and 50),
  slot_ts       timestamptz,               -- ticketed entry time; null = no slot
  checked_in_at timestamptz not null default now(),
  group_no      int,                       -- set when the group is called
  called_at     timestamptz,
  arrived_at    timestamptz                -- marked at the house door
);
create index if not exists hm_queue_night on public.hm_queue (event_date, group_no);

alter table public.hm_queue enable row level security;
revoke all on public.hm_queue from anon, authenticated;

-- Where a party stands in line: its entry time if it checked in no later
-- than 10 minutes after it, otherwise the first half-hour session that it
-- can still make by that rule.
create or replace function public.hm_queue_eff(p_slot timestamptz, p_in timestamptz)
returns timestamptz language sql immutable as $$
  select case
    when p_slot is null then p_in
    when p_in <= p_slot + interval '10 minutes' then p_slot
    else p_slot + interval '30 minutes'
           * ceil(extract(epoch from (p_in - p_slot - interval '10 minutes')) / 1800.0)
  end
$$;

create or replace function public.hm_queue_call(p_date date, p_size int default 15)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  g int;
  total int := 0;
  r record;
begin
  -- Two staff phones pressing at once must not make two groups of the same people.
  perform pg_advisory_xact_lock(hashtext('hm_queue_call'));
  select coalesce(max(group_no), 0) + 1 into g from hm_queue where event_date = p_date;
  -- Locked rows, so a party removed or put back mid-call is not counted;
  -- a ticket refunded after check-in is never called.
  for r in
    select q.ticket_code, q.party from hm_queue q join hm_orders o using (ticket_code)
     where q.event_date = p_date and q.group_no is null and o.status = 'paid'
     order by hm_queue_eff(q.slot_ts, q.checked_in_at), q.checked_in_at, q.ticket_code
     for update of q
  loop
    if total = 0 or total + r.party <= p_size then
      update hm_queue set group_no = g, called_at = now() where ticket_code = r.ticket_code;
      total := total + r.party;
    end if;
    exit when total >= p_size;
  end loop;
  if total = 0 then return null; end if;
  return g;
end
$$;

revoke all on function public.hm_queue_eff(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.hm_queue_call(date, int) from public, anon, authenticated;
grant all on public.hm_queue to service_role;
grant execute on function public.hm_queue_call(date, int) to service_role;

-- The night it is now in New York. The house runs past midnight, and
-- anything before 4 AM still belongs to the night before (as the slots do).
create or replace function public.hm_tonight()
returns date language sql stable as $$
  select ((now() at time zone 'America/New_York') - interval '4 hours')::date
$$;

-- Check a ticket in at The Graveyard. A ticket for another night is refused
-- unless staff say to let it in anyway (p_force); then it joins tonight's
-- line at its own entry time.
create or replace function public.hm_queue_checkin(p_code text, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o record;
  night date := hm_tonight();
begin
  select ticket_code, event_date, slot, tickets, status into o from hm_orders where ticket_code = p_code;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if o.status <> 'paid' then return jsonb_build_object('error', 'not_paid', 'status', o.status); end if;
  if o.event_date <> night and not p_force then
    return jsonb_build_object('error', 'wrong_night', 'night', o.event_date);
  end if;
  -- Two phones scanning the same ticket at once: the second is "already".
  insert into hm_queue (ticket_code, event_date, party, slot_ts)
  values (o.ticket_code, night, o.tickets,
          case when o.slot is null then null
               else ((night + o.slot + case when o.slot < time '04:00' then interval '1 day' else interval '0' end)
                     at time zone 'America/New_York') end)
  on conflict (ticket_code) do nothing;
  return jsonb_build_object('ok', true, 'already', not found);
end
$$;

revoke all on function public.hm_queue_checkin(text, boolean) from public, anon, authenticated;
revoke all on function public.hm_tonight() from public, anon, authenticated;
grant execute on function public.hm_tonight() to service_role;
grant execute on function public.hm_queue_checkin(text, boolean) to service_role;
