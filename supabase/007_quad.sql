-- 007: the four-ticket price.
--
-- 006 deliberately left this row out. At the time the owner had said the
-- four-ticket price was "not sixty, because then it kind of defeats the
-- purpose," so there was no number to write and shipping a guess would have
-- been shipping a wrong price.
--
-- 2026-09-16, later the same day, by voice: "The prices are $20 for one
-- ticket, $35 for two tickets. And $60 for four tickets." Newer instruction,
-- same speaker, so sixty it is. faq.html already quotes these three numbers;
-- without this row the four-ticket button on nights.html 404s on
-- unknown_product, so the page and the database disagree until this runs.
--
-- If the owner meant to hold at a discount, change cents here and in
-- faq.html together - those are the only two places the number lives.

begin;

insert into public.hm_products (code, label, tickets, cents, is_active, sort) values
  ('quad', 'Four tickets', 4, 6000, true, 3)
on conflict (code) do update
  set label = excluded.label,
      tickets = excluded.tickets,
      cents = excluded.cents,
      is_active = excluded.is_active,
      sort = excluded.sort;

commit;
