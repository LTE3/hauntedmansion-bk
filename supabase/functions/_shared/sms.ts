// The rules for texting the waitlist, as code, with no I/O in them. Both edge
// functions import this, and supabase/tests/sms.test.mjs runs it under Node -
// which is why the TypeScript here is the erasable kind (annotations only, no
// enums, no parameter properties) so Node can strip it without a build step.

export const BRAND = "Haunted Mansion BK";
export const OPERATOR = "Pulse Ticketing LLC";
export const STOP_FOOTER = "Reply STOP to opt out.";

// Twilio's standard keywords, plus the words the FCC's revocation rule expects
// a reasonable person to use. Matched on the first word (or first two), case-
// insensitively, punctuation ignored, so "Stop!", "unsubscribe please" and
// "opt out" all count. When in doubt the answer is "stop": a text we should
// have sent and did not costs one ticket sale; the reverse costs a lawsuit.
const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT", "REMOVE"];
const START_WORDS = ["START", "UNSTOP", "YES", "SUBSCRIBE", "RESUME"];
const HELP_WORDS = ["HELP", "INFO"];

export type Keyword = "stop" | "start" | "help" | null;

export function keyword(body: string): Keyword {
  const words = body.toUpperCase().replace(/[^A-Z\s]/g, " ").trim().split(/\s+/);
  const first = words[0] ?? "";
  const two = words.slice(0, 2).join(" ");
  if (STOP_WORDS.includes(first) || two === "OPT OUT") return "stop";
  if (START_WORDS.includes(first) || two === "OPT IN") return "start";
  if (HELP_WORDS.includes(first)) return "help";
  return null;
}

// A US or Canadian number in any of the usual shapes, or null. The same rule
// as public.hm_e164() in 005_sms_consent.sql; keep them agreeing.
export function e164(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null;
}

// For logs and responses: a number nobody needs to see whole.
export function mask(phone: string): string {
  if (phone.length <= 6) return phone;
  return phone.slice(0, 2) + "*".repeat(phone.length - 6) + phone.slice(-4);
}

// Every marketing text has to say who it is from and how to make it stop.
// The operator writes the message; this makes sure those two things are in it.
export function compose(message: string): string {
  let body = message
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body) throw new Error("empty message");
  if (!new RegExp(BRAND.replace(/ /g, "\\s+"), "i").test(body)) body = BRAND + ": " + body;
  if (!/\bSTOP\b/i.test(body)) body = body + " " + STOP_FOOTER;
  return body;
}

// Segment count, the unit Twilio bills by. GSM-7 fits 160 characters in one
// segment and 153 per segment after that; anything outside the GSM alphabet
// (curly quotes, emoji, an em dash) forces UCS-2 at 70 / 67. The sender
// reports this so a blast is never sent at double price by accident.
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";

export type Segments = { encoding: "GSM-7" | "UCS-2"; units: number; segments: number };

export function segments(body: string): Segments {
  let units = 0;
  for (const ch of body) {
    if (GSM.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      const u = body.length; // UTF-16 code units; an emoji is two
      return { encoding: "UCS-2", units: u, segments: u <= 70 ? 1 : Math.ceil(u / 67) };
    }
  }
  return { encoding: "GSM-7", units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
}

// Federal rules allow marketing texts between 8:00 and 21:00 in the
// recipient's local time. Every number on this list is +1 and nearly all are
// in New York, but "nearly all" is not a defence, so the window is set in
// Eastern time and narrowed until it sits inside 8-21 for every mainland US
// zone: 11:00 ET is 08:00 in Los Angeles, and 20:59 ET is still before 21:00
// for everyone east of it.
export const QUIET_ZONE = "America/New_York";
export const SEND_FROM_HOUR = 11;
export const SEND_UNTIL_HOUR = 21;

export function localHour(now: Date, zone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hour12: false }).format(now);
  return Number(h) % 24; // some engines print midnight as "24"
}

export function sendWindowOpen(now: Date = new Date()): boolean {
  const h = localHour(now, QUIET_ZONE);
  return h >= SEND_FROM_HOUR && h < SEND_UNTIL_HOUR;
}

// Twilio signs every webhook it sends: HMAC-SHA1 over the full URL followed by
// each POST parameter's name and value, sorted by name, keyed with the account
// auth token. A request whose signature does not match did not come from
// Twilio, whatever its body says.
export async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  let s = "";
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return btoa(s);
}

// Compare two secrets without letting the time it takes say how close they are.
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string);
}

// TwiML: an empty <Response/> tells Twilio "received, say nothing".
export function twimlBody(message?: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    (message ? "<Message>" + xmlEscape(message) + "</Message>" : "") +
    "</Response>";
}

// The replies, when this side sends them (see hm-sms-inbound for when it
// does). Each is one GSM-7 segment; the test checks that.
export const STOP_REPLY = BRAND + ": you are unsubscribed and will get no more texts from us. Reply START to rejoin.";
export const START_REPLY = BRAND + ": you are back on the list. Opening night and ticket texts only. Msg&data rates may apply. Reply STOP to opt out.";
export const DEFAULT_HELP_CONTACT = "hauntedmansionbk.com";

export function helpReply(contact: string = DEFAULT_HELP_CONTACT): string {
  return BRAND + " (" + OPERATOR + ") texts: opening night and ticket on-sales. Msg&data rates may apply. Reply STOP to opt out. Help: " + contact;
}
