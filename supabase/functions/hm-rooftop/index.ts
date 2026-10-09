// The Graveyard - Hidden Rooftop: free table reservations (owner, 2026-10-08).
//
//   POST /functions/v1/hm-rooftop   { "action": "nights" }
//   200: { nights: [{ date, label, times: ["18:00", ...] }] }
//
//   POST /functions/v1/hm-rooftop   { "event_date": "2026-10-16", "slot": "21:00", "party": 4,
//                                     "name": "...", "email": "...", "phone": "optional",
//                                     "ticket": "optional HM- code", "website": "" }
//   200: { code, night, time, party }
//   400/404/409/429: { error: "bad_request" | "bad_email" | "unknown_night" | "unknown_time" | "too_many" }
//
// Free: no Stripe, pay at the bar. Open the nights the house is open, on the
// hour from 6 PM to the house's last entry. Unlimited tables for now, so the
// only limit is per email (a few live reservations per night), which keeps a
// script from using this as a way to mail strangers.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HM_VENUE_ADDRESS, mail secrets.

import { insert, rest, select } from "../_shared/db.ts";
import { SITE, TZ, clock, nightLabel, validEmail } from "../_shared/pay.ts";
import { sendEmail } from "../_shared/mail.ts";
import { MAX_PARTY, rooftopConfirmEmail, rooftopTimes } from "../_shared/rooftop.ts";

const ORIGINS = new Set([SITE, "http://127.0.0.1:8000", "http://localhost:8000", "http://localhost:8765"]);
const PER_EMAIL_PER_NIGHT = 3;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.has(o) ? o : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

function todayNY(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

interface Night { event_date: string }
interface Slot { event_date: string; slot: string }

// Nights still ahead (tonight included) that are on sale, with their times.
async function openNights(): Promise<{ date: string; label: string; times: string[] }[]> {
  const today = todayNY();
  const nights = await select<Night>("hm_events?is_active=is.true&event_date=gte." + today + "&select=event_date&order=event_date");
  if (!nights.length) return [];
  const slots = await select<Slot>("hm_slots?event_date=gte." + today + "&select=event_date,slot");
  return nights.map((n) => {
    const own = slots.filter((s) => s.event_date === n.event_date).map((s) => s.slot.slice(0, 5));
    return { date: n.event_date, label: nightLabel(n.event_date), times: rooftopTimes(own) };
  }).filter((n) => n.times.length);
}

function code(): string {
  return "GY-" + crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "method" });

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return reply(req, 400, { error: "bad_request" });
  }

  try {
    if (b.action === "nights") return reply(req, 200, { nights: await openNights() });

    // A filled honeypot gets a quiet success and nothing else.
    if (typeof b.website === "string" && b.website.trim()) return reply(req, 200, { code: "GY-000000" });

    const date = typeof b.event_date === "string" ? b.event_date : "";
    const slot = typeof b.slot === "string" ? b.slot : "";
    const party = Number(b.party);
    const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ").slice(0, 80) : "";
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const phone = typeof b.phone === "string" ? b.phone.replace(/[^\d+]/g, "").slice(0, 20) : "";
    const ticket = typeof b.ticket === "string" && /^HM-[0-9A-F]{8}$/.test(b.ticket) ? b.ticket : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):00$/.test(slot) || !name ||
        !Number.isInteger(party) || party < 1 || party > MAX_PARTY) {
      return reply(req, 400, { error: "bad_request" });
    }
    if (!validEmail(email)) return reply(req, 400, { error: "bad_email" });

    const night = (await openNights()).find((n) => n.date === date);
    if (!night) return reply(req, 404, { error: "unknown_night" });
    if (!night.times.includes(slot)) return reply(req, 404, { error: "unknown_time" });

    const mine = await select<{ id: string }>("hm_rooftop_reservations?event_date=eq." + date +
      "&email=eq." + encodeURIComponent(email) + "&status=eq.booked&select=id");
    if (mine.length >= PER_EMAIL_PER_NIGHT) return reply(req, 429, { error: "too_many" });

    const c = code();
    await insert("hm_rooftop_reservations", {
      code: c, event_date: date, slot, party, name, email, phone: phone || null, ticket_code: ticket,
    });

    const msg = rooftopConfirmEmail({
      code: c, eventDate: date, slot, party, name, venueAddress: Deno.env.get("HM_VENUE_ADDRESS") || "",
    });
    const sent = await sendEmail(email, msg).catch((e) => ({ ok: false, error: String((e as Error).message) }));
    await rest("hm_rooftop_reservations?code=eq." + c, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify(sent.ok ? { email_sent_at: new Date().toISOString() } : { email_error: (sent.error || "send failed").slice(0, 300) }),
    }).catch(() => {});

    return reply(req, 200, { code: c, night: night.label, time: clock(slot), party, emailed: sent.ok });
  } catch (e) {
    console.error("hm-rooftop", (e as Error).message);
    return reply(req, 500, { error: "server" });
  }
});
