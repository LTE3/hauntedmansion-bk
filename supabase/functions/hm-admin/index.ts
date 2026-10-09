// The owner's dashboard, read-only. One call returns everything admin.html
// draws: every night's capacity and sales, every order that got past
// checkout, the waitlist, and the rooftop table reservations.
//
//   POST /functions/v1/hm-admin
//   headers: x-hm-admin: <HM_ADMIN_TOKEN>
//   200: { nights, slots, orders, waitlist, rooftop, generated_at }
//
// Deployed with --no-verify-jwt: the token is the gate, and the page never
// holds the anon key. Nothing here writes - refunds and scans happen
// elsewhere - so a leaked token exposes the list but cannot move money.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform); HM_ADMIN_TOKEN.

import { select } from "../_shared/db.ts";
import { SITE, timingSafeEqual } from "../_shared/pay.ts";

const ORIGINS = new Set([SITE, "http://127.0.0.1:8000", "http://localhost:8000"]);

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.has(o) ? o : SITE,
    "Access-Control-Allow-Headers": "content-type, x-hm-admin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "method" });

  const want = Deno.env.get("HM_ADMIN_TOKEN");
  if (!want) return reply(req, 503, { error: "not_configured" });
  if (!timingSafeEqual(want, req.headers.get("x-hm-admin") || "")) {
    // A wrong guess costs the guesser a second; the owner never notices.
    await new Promise((r) => setTimeout(r, 1000));
    return reply(req, 401, { error: "unauthorized" });
  }

  try {
    const [nights, slots, orders, waitlist, rooftop] = await Promise.all([
      select("hm_events?select=event_date,doors,last_entry,capacity,sold,is_active&order=event_date"),
      select("hm_slots?select=event_date,slot,adults_only,capacity,sold&order=event_date,slot"),
      select(
        "hm_orders?select=event_date,slot,product,tickets,amount_cents,email,name,status,ticket_code,livemode,created_at,paid_at,scanned_at" +
          "&status=in.(paid,oversold,refunded)&order=paid_at.desc.nullslast&limit=5000",
      ),
      select("hm_waitlist?select=name,email,phone,source,created_at&order=created_at.desc&limit=10000"),
      select(
        "hm_rooftop_reservations?select=code,event_date,slot,party,name,email,phone,ticket_code,status,email_sent_at,email_error,created_at" +
          "&order=event_date,slot,created_at&limit=5000",
      ),
    ]);
    return reply(req, 200, { nights, slots, orders, waitlist, rooftop, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error("hm-admin", e);
    return reply(req, 500, { error: "db" });
  }
});
