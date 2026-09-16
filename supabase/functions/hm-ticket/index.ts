// Read a ticket. Nothing here writes, so it is safe to call from the success
// page, from a guest's phone, and from a mail client fetching the QR image.
//
//   GET /functions/v1/hm-ticket?s=<checkout session id>   (the success page)
//   GET /functions/v1/hm-ticket?t=<ticket code>            (the link in the email)
//   200: { status, event_date, night, doors, last_entry, tickets, product,
//          ticket_code (paid only), name, email (masked) }
//   GET /functions/v1/hm-ticket?qr=<ticket code>           image/gif of the code
//
// Deployed with --no-verify-jwt so an <img> in an email can fetch the QR.
// Both lookups are by an unguessable key. The venue's address is never in
// any response from this function; it is in the email and nowhere else.
//
// Env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (platform).

import { select } from "../_shared/db.ts";
import { SITE, TICKET_CODE, maskEmail, nightLabel } from "../_shared/pay.ts";

const ORIGINS = new Set([SITE, "http://127.0.0.1:8000", "http://localhost:8000"]);

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.has(o) ? o : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface Row {
  status: string; event_date: string; tickets: number; product: string; ticket_code: string | null;
  name: string | null; email: string | null;
  hm_events: { doors: string; last_entry: string } | null;
  hm_products: { label: string } | null;
}

const FIELDS = "status,event_date,tickets,product,ticket_code,name,email,hm_events(doors,last_entry),hm_products(label)";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "GET") return reply(req, 405, { error: "method" });

  const u = new URL(req.url);
  const qr = u.searchParams.get("qr");
  const s = u.searchParams.get("s");
  const t = u.searchParams.get("t");

  if (qr) {
    if (!TICKET_CODE.test(qr)) return reply(req, 400, { error: "bad_code" });
    try {
      const { qrcode } = await import("https://deno.land/x/qrcode@v2.0.0/mod.ts");
      const dataUrl = String(await qrcode(SITE + "/ticket.html?t=" + qr, { size: 300 }));
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bytes, {
        headers: { ...cors(req), "Content-Type": "image/gif", "Cache-Control": "public, max-age=86400" },
      });
    } catch (e) {
      console.error("qr", (e as Error).message);
      return reply(req, 500, { error: "qr" });
    }
  }

  let filter = "";
  if (s && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(s)) filter = "stripe_session_id=eq." + s;
  else if (t && TICKET_CODE.test(t)) filter = "ticket_code=eq." + t;
  else return reply(req, 400, { error: "bad_request" });

  try {
    const [o] = await select<Row>("hm_orders?" + filter + "&select=" + FIELDS);
    if (!o) return reply(req, 404, { error: "not_found" });
    return reply(req, 200, {
      status: o.status,
      event_date: o.event_date,
      night: nightLabel(o.event_date),
      doors: o.hm_events?.doors || null,
      last_entry: o.hm_events?.last_entry || null,
      tickets: o.tickets,
      product: o.hm_products?.label || o.product,
      ticket_code: o.status === "paid" ? o.ticket_code : null,
      name: o.name,
      email: maskEmail(o.email),
    });
  } catch (e) {
    console.error((e as Error).message);
    return reply(req, 500, { error: "server" });
  }
});
