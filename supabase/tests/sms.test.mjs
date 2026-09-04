// The texting rules, checked. Runs under plain Node (24+, which strips the
// types from the .ts import itself):
//
//     node --test supabase/tests/sms.test.mjs
//
// No network, no database, no Twilio: these are the pure rules in
// functions/_shared/sms.ts, which is where a wrong answer would cost the most.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRAND, compose, DEFAULT_HELP_CONTACT, e164, helpReply, keyword, localHour, mask, segments, sendWindowOpen,
  START_REPLY, STOP_REPLY, timingSafeEqual, twilioSignature, twimlBody,
} from "../functions/_shared/sms.ts";

test("keywords: every way people say stop is stop", () => {
  for (const b of ["STOP", "stop", "Stop!", "  stop  ", "STOPALL", "unsubscribe please", "cancel", "END", "Quit", "revoke", "opt out", "Opt-out", "remove me"]) {
    assert.equal(keyword(b), "stop", JSON.stringify(b));
  }
});

test("keywords: start, help, and ordinary words", () => {
  for (const b of ["START", "yes", "Unstop", "opt in", "resume"]) assert.equal(keyword(b), "start", b);
  for (const b of ["HELP", "help?", "info"]) assert.equal(keyword(b), "help", b);
  for (const b of ["", "hi", "what time do you open", "stopping by tonight?".replace("stopping", "coming"), "is this the stop for the bus"]) {
    assert.equal(keyword(b), null, JSON.stringify(b));
  }
});

test("keywords: a stop word later in the sentence does not count, the first word does", () => {
  assert.equal(keyword("please stop"), null);
  assert.equal(keyword("stop please"), "stop");
});

test("e164: US shapes in, +1 out, everything else null", () => {
  assert.equal(e164("3475550100"), "+13475550100");
  assert.equal(e164("(347) 555-0100"), "+13475550100");
  assert.equal(e164("1-347-555-0100"), "+13475550100");
  assert.equal(e164("+1 347 555 0100"), "+13475550100");
  assert.equal(e164("+44 20 7946 0958"), null);
  assert.equal(e164("555-0100"), null);
  assert.equal(e164(""), null);
});

test("mask keeps the last four and nothing else worth having", () => {
  assert.equal(mask("+13475550100"), "+1******0100");
  assert.equal(mask("abc"), "abc");
});

test("compose adds the sender and the way out, once", () => {
  const b = compose("Doors open Sept 25. Tickets Friday.");
  assert.equal(b, "Haunted Mansion BK: Doors open Sept 25. Tickets Friday. Reply STOP to opt out.");
  assert.equal(compose(b), b, "already compliant text is left alone");
  assert.equal(compose("haunted mansion bk here. Reply STOP to end."), "haunted mansion bk here. Reply STOP to end.");
  assert.throws(() => compose("   "), /empty/);
});

test("compose keeps paragraph breaks and squashes runs of spaces", () => {
  assert.equal(compose("Line   one\n\n\n\nLine two"), BRAND + ": Line one\n\nLine two Reply STOP to opt out.");
});

test("segments: GSM-7 at 160/153, UCS-2 at 70/67", () => {
  assert.deepEqual(segments("a".repeat(160)), { encoding: "GSM-7", units: 160, segments: 1 });
  assert.deepEqual(segments("a".repeat(161)), { encoding: "GSM-7", units: 161, segments: 2 });
  assert.deepEqual(segments("a".repeat(306)), { encoding: "GSM-7", units: 306, segments: 2 });
  assert.deepEqual(segments("a".repeat(307)), { encoding: "GSM-7", units: 307, segments: 3 });
  assert.equal(segments("price {5}").units, 11, "nine characters, braces cost two each");
  assert.equal(segments("a".repeat(69) + "🎃").encoding, "UCS-2");
  assert.equal(segments("a".repeat(69) + "🎃").segments, 2, "an emoji is two UTF-16 units");
  assert.equal(segments("an em dash — costs the whole message").encoding, "UCS-2");
});

test("the canned replies each fit one segment", () => {
  for (const r of [STOP_REPLY, START_REPLY, helpReply(), helpReply(DEFAULT_HELP_CONTACT)]) {
    const s = segments(r);
    assert.equal(s.encoding, "GSM-7", r);
    assert.equal(s.segments, 1, r + " (" + s.units + ")");
  }
  assert.match(helpReply(), /Pulse Ticketing LLC/);
  assert.match(helpReply(), /STOP/);
});

test("send window: 11:00-20:59 Eastern, daylight time in September", () => {
  assert.equal(localHour(new Date("2026-09-25T15:00:00Z"), "America/New_York"), 11);
  assert.equal(sendWindowOpen(new Date("2026-09-25T14:59:00Z")), false, "10:59 EDT");
  assert.equal(sendWindowOpen(new Date("2026-09-25T15:00:00Z")), true, "11:00 EDT");
  assert.equal(sendWindowOpen(new Date("2026-09-26T00:59:00Z")), true, "20:59 EDT");
  assert.equal(sendWindowOpen(new Date("2026-09-26T01:00:00Z")), false, "21:00 EDT");
  assert.equal(sendWindowOpen(new Date("2026-09-26T04:00:00Z")), false, "midnight EDT");
});

test("send window follows the clock change", () => {
  // 15:00Z is 10:00 EST once daylight time ends.
  assert.equal(sendWindowOpen(new Date("2026-12-01T15:00:00Z")), false);
  assert.equal(sendWindowOpen(new Date("2026-12-01T16:00:00Z")), true);
});

test("twilio signature matches Twilio's published example", async () => {
  // The worked example in Twilio's "Validating Signatures from Twilio" doc:
  // token 12345, this URL, these params, this signature.
  const sig = await twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {
    CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212",
  });
  assert.equal(sig, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

test("timingSafeEqual", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

test("twiml: empty says nothing, a message is escaped", () => {
  assert.equal(twimlBody(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.equal(twimlBody("a & b <c>"), '<?xml version="1.0" encoding="UTF-8"?><Response><Message>a &amp; b &lt;c&gt;</Message></Response>');
});
