-- Half-hour entry (owner, 2026-10-15): "25 people every 30 min".
--
-- From tonight every entry time holds 25, and every hour of the night gets
-- a half-past entry as well - except the night's last hour, so the night
-- still ends where it did. The half-past slot keeps its hour's session
-- (7:30 is all ages, 8:30 is 18+).
--
-- Tickets already sold stay where they are. An hour that had sold past 25
-- keeps what it sold and shows as full: capacity is raised to cover it
-- rather than overselling (hm_slots_not_oversold). Checkouts still open at
-- Stripe (sessions live 30 minutes) are counted in too, so a guest who is
-- mid-payment is not turned into an oversold order.

begin;

update public.hm_slots s
   set capacity = greatest(25, s.sold + coalesce((
         select sum(o.tickets) from public.hm_orders o
          where o.event_date = s.event_date and o.slot = s.slot
            and o.status = 'pending' and o.created_at > now() - interval '35 minutes'), 0))
 where s.event_date >= date '2026-10-15';

-- 00:00 is the end of the night, so it sorts as hour 24.
insert into public.hm_slots (event_date, slot, adults_only, capacity)
select s.event_date, s.slot + interval '30 minutes', s.adults_only, 25
  from public.hm_slots s
 where s.event_date >= date '2026-10-15'
   and extract(minute from s.slot) = 0
   and (extract(hour from s.slot)::int + case when extract(hour from s.slot) < 4 then 24 else 0 end)
       < (select max(extract(hour from x.slot)::int + case when extract(hour from x.slot) < 4 then 24 else 0 end)
            from public.hm_slots x where x.event_date = s.event_date)
on conflict (event_date, slot) do nothing;

commit;
