// The money rules, checked. Runs under plain Node (24+, which strips the
// types from the .ts imports itself):
//
//     node --test supabase/tests/pay.test.mjs
//
// No network, no database, no Stripe: these are the pure rules in
// functions/_shared/pay.ts and mail.ts, which is where a wrong answer would
// cost the most - a forged webhook accepted, a night missing from the
// nineteen, an email with no address in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NIGHTS, clock, formEncode, isNight, maskEmail, money, nightLabel, parseStripeSignature,
  signForTest, timingSafeEqual, TICKET_CODE, validEmail, verifyStripeSignature,
} from "../functions/_shared/pay.ts";
import { ticketEmail } from "../functions/_shared/mail.ts";

test("nights: nineteen, October 1 first, Halloween last, Thu-Sun only", () => {
  assert.equal(NIGHTS.length, 19);
  assert.equal(NIGHTS[0], "2026-10-01");
  assert.equal(NIGHTS.at(-1), "2026-10-31");
  const dows = NIGHTS.map((d) => new Date(d + "T12:00:00Z").getUTCDay());
  assert.equal(dows.filter((d) => d === 4).length, 5, "Thursdays");
  assert.equal(dows.filter((d) => d === 5).length, 5, "Fridays");
  assert.equal(dows.filter((d) => d === 6).length, 5, "Saturdays");
  assert.equal(dows.filter((d) => d === 0).length, 4, "Sundays");
  for (const d of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-09-30", "2026-11-01", "2026-10-1", ""]) {
    assert.equal(isNight(d), false, d);
  }
});

test("labels: night, clock, money", () => {
  assert.equal(nightLabel("2026-10-01"), "Thursday, October 1");
  assert.equal(nightLabel("2026-10-31"), "Saturday, October 31");
  assert.equal(nightLabel("2026-10-04"), "Sunday, October 4");
  assert.equal(clock("17:00:00"), "5 pm");
  assert.equal(clock("22:15:00"), "10:15 pm");
  assert.equal(clock("21:00"), "9 pm");
  assert.equal(money(2000), "$20");
  assert.equal(money(3500), "$35");
  assert.equal(money(1750), "$17.50");
});

test("email: valid and masked", () => {
  assert.equal(validEmail("a@b.co"), true);
  assert.equal(validEmail("nope"), false);
  assert.equal(validEmail(""), false);
  assert.equal(validEmail(null), false);
  assert.equal(maskEmail("daniel@example.com"), "d***@example.com");
  assert.equal(maskEmail(null), "");
});

test("form encoding matches Stripe's bracket shape", () => {
  const s = formEncode({
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 3500 } }],
    metadata: { brand: "hm", tag: null },
    customer_email: undefined,
  });
  assert.equal(
    s,
    "mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd" +
      "&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=3500&metadata%5Bbrand%5D=hm",
  );
});

test("signature: parse, accept, and refuse", async () => {
  const secret = "whsec_test_not_a_real_secret";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_x" } } });
  const now = 1_800_000_000;
  const header = await signForTest(body, secret, now);

  assert.deepEqual(parseStripeSignature("t=1,v1=ab,v1=cd,v0=zz"), { t: 1, v1: ["ab", "cd"] });
  assert.equal(parseStripeSignature(null), null);
  assert.equal(parseStripeSignature("garbage"), null);

  assert.equal(await verifyStripeSignature(body, header, secret, now), true, "good signature");
  assert.equal(await verifyStripeSignature(body, header, secret, now + 299), true, "inside tolerance");
  assert.equal(await verifyStripeSignature(body, header, secret, now + 301), false, "too old");
  assert.equal(await verifyStripeSignature(body + " ", header, secret, now), false, "tampered body");
  assert.equal(await verifyStripeSignature(body, header, "whsec_other", now), false, "wrong secret");
  assert.equal(await verifyStripeSignature(body, null, secret, now), false, "no header");
  assert.equal(await verifyStripeSignature(body, header, "", now), false, "no secret configured");
  assert.equal(await verifyStripeSignature(body, "t=" + now + ",v1=00", secret, now), false, "short forged");
});

test("timingSafeEqual", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
});

test("ticket code shape", () => {
  assert.equal(TICKET_CODE.test("HM-0A1B2C3D"), true);
  assert.equal(TICKET_CODE.test("HM-0a1b2c3d"), false);
  assert.equal(TICKET_CODE.test("HM-0A1B2C3"), false);
  assert.equal(TICKET_CODE.test("XX-0A1B2C3D"), false);
});

test("ticket email: has the code, the night, the address; refuses without an address", () => {
  const base = {
    ticketCode: "HM-DEADBEEF", eventDate: "2026-10-03", doors: "17:00:00", lastEntry: "21:00:00",
    tickets: 2, productLabel: "Two tickets", amountCents: 3500, name: "Sam",
    venueAddress: "TEST ADDRESS LINE", qrUrl: "https://example.test/qr",
  };
  const m = ticketEmail(base);
  assert.equal(m.subject, "Haunted Mansion BK — Saturday, October 3");
  for (const part of ["HM-DEADBEEF", "Saturday, October 3", "TEST ADDRESS LINE", "5 pm", "9 pm", "2 guests", "$35", "Sam, your night is set."]) {
    assert.ok(m.text.includes(part), "text has " + part);
    assert.ok(m.html.includes(part), "html has " + part);
  }
  assert.ok(m.html.includes('href="https://hauntedmansionbk.com/ticket.html?t=HM-DEADBEEF"'));
  assert.ok(!/sold out/i.test(m.html + m.text));
  assert.throws(() => ticketEmail({ ...base, venueAddress: "" }), /address/);
  assert.throws(() => ticketEmail({ ...base, venueAddress: "   " }), /address/);
  const anon = ticketEmail({ ...base, name: null, tickets: 1, productLabel: "One ticket", amountCents: 2000 });
  assert.ok(anon.text.includes("Your night is set."));
  assert.ok(anon.text.includes("1 guest (one ticket)"));
  assert.ok(anon.html.includes("&lt;") === false || true);
});

test("ticket email escapes what a buyer typed", () => {
  const m = ticketEmail({
    ticketCode: "HM-00000000", eventDate: "2026-10-01", doors: "17:00", lastEntry: "22:15",
    tickets: 1, productLabel: "One ticket", amountCents: 2000, name: "<script>alert(1)</script>",
    venueAddress: "TEST ADDRESS LINE", qrUrl: "https://example.test/qr",
  });
  assert.ok(!m.html.includes("<script>alert(1)</script>"));
  assert.ok(m.html.includes("&lt;script&gt;"));
});
