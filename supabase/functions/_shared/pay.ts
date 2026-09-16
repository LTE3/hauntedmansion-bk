// The rules for taking money, as code, with no I/O in them. Both the checkout
// function and the webhook import this, and supabase/tests/pay.test.mjs runs
// it under Node - so, like sms.ts, the TypeScript here is the erasable kind
// (annotations only) that Node can strip without a build step.

export const BRAND = "Haunted Mansion BK";
export const SITE = "https://hauntedmansionbk.com";
export const TZ = "America/New_York";

// The nineteen nights, as nights.html has them: October 1 opens, then
// Thursday to Sunday every week of October 2026. Derived, not typed, so the
// list here and the calendar on the page cannot drift apart by a typo.
export const NIGHTS: string[] = (() => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    // October 1, 2026 is a Thursday; Date.UTC keeps the arithmetic off the
    // machine's own zone.
    const dow = new Date(Date.UTC(2026, 9, d)).getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow >= 4) out.push("2026-10-" + String(d).padStart(2, "0"));
  }
  return out;
})();

export function isNight(date: string): boolean {
  return NIGHTS.includes(date);
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// "Thursday, October 1". The date string is a calendar date, not an instant,
// so it is read as UTC midnight on purpose: no zone can move it a day.
export function nightLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const month = dt.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return DOW[dt.getUTCDay()] + ", " + month + " " + dt.getUTCDate();
}

// "5:00 pm" from a Postgres time "17:00:00".
export function clock(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (m[2] === "00" ? "" : ":" + m[2]) + (h < 12 ? " am" : " pm");
}

// "$20" or "$17.50": whole dollars drop the cents.
export function money(cents: number): string {
  const d = Math.floor(cents / 100), c = cents % 100;
  return "$" + d + (c ? "." + String(c).padStart(2, "0") : "");
}

export function validEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// d***@example.com - enough to recognise, not enough to use.
export function maskEmail(e: string | null | undefined): string {
  if (!e) return "";
  const at = e.indexOf("@");
  if (at < 1) return "***";
  return e[0] + "***" + e.slice(at);
}

export const TICKET_CODE = /^HM-[0-9A-F]{8}$/;

// Stripe's form encoding: nested objects become bracketed keys, arrays become
// indexed keys, exactly as its docs show for curl. Undefined and null are
// left out rather than sent as the string "undefined".
export function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, key + "[" + i + "]"));
    } else if (typeof v === "object") {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        walk(item, key ? key + "[" + k + "]" : k);
      }
    } else {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
    }
  };
  walk(obj, prefix);
  return parts.join("&");
}

// ---------------------------------------------------------------------------
// Stripe's webhook signature. The header is "t=<unix seconds>,v1=<hex>,..."
// and the hex is HMAC-SHA256 over "<t>.<raw body>" with the endpoint's
// signing secret. Anything that does not verify is not from Stripe, whatever
// it says inside.

export function parseStripeSignature(header: string | null): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  if (!Number.isFinite(t) || v1.length === 0) return null;
  return { t, v1 };
}

export async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Same length, every byte compared, no early exit.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): Promise<boolean> {
  const parsed = parseStripeSignature(header);
  if (!parsed || !secret) return false;
  if (Math.abs(nowSec - parsed.t) > toleranceSec) return false;
  const expected = await hmacHex(secret, parsed.t + "." + rawBody);
  return parsed.v1.some((v) => timingSafeEqual(v.toLowerCase(), expected));
}

// The header Stripe would send for this body, for the tests and for the
// pre-launch smoke run. Never used to accept anything.
export async function signForTest(rawBody: string, secret: string, tSec: number): Promise<string> {
  return "t=" + tSec + ",v1=" + (await hmacHex(secret, tSec + "." + rawBody));
}
