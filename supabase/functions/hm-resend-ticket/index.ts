// Re-send one paid order's ticket email - for when the owner moves an order
// to another night and the guest needs the updated ticket. Same email the
// webhook sends on purchase, built from the order row as it is now.
//
//   POST /functions/v1/hm-resend-ticket
//   headers: x-hm-admin: <HM_ADMIN_TOKEN>
//   body: { ticket_code: "HM-XXXXXXXX" }
//   200: { ok: true, to } | 4xx/5xx { error }
//
// Deployed with --no-verify-jwt: the admin token is the gate. Sends mail
// only; it never touches money or seat counts.
//
// Env: HM_ADMIN_TOKEN, HM_VENUE_ADDRESS, HM_GMAIL_* (via sendEmail);
//      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (platform).

import { rest, select } from "../_shared/db.ts";
import { sendEmail, ticketEmail } from "../_shared/mail.ts";
import { timingSafeEqual } from "../_shared/pay.ts";

const JSONH = { "Content-Type": "application/json" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSONH });

interface Order {
  stripe_session_id: string; event_date: string; slot: string | null; product: string; tickets: number;
  amount_cents: number; email: string | null; name: string | null; ticket_code: string; status: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "method" });
  const want = Deno.env.get("HM_ADMIN_TOKEN");
  if (!want) return reply(503, { error: "not_configured" });
  if (!timingSafeEqual(want, req.headers.get("x-hm-admin") || "")) {
    await new Promise((r) => setTimeout(r, 1000));
    return reply(401, { error: "unauthorized" });
  }

  let code = "";
  try { code = String((await req.json()).ticket_code || ""); } catch { /* fall through */ }
  if (!/^HM-[A-F0-9]{8}$/.test(code)) return reply(400, { error: "bad_ticket_code" });

  try {
    const [o] = await select<Order>("hm_orders?ticket_code=eq." + code +
      "&select=stripe_session_id,event_date,slot,product,tickets,amount_cents,email,name,ticket_code,status");
    if (!o) return reply(404, { error: "unknown_order" });
    if (o.status !== "paid") return reply(409, { error: "not_paid" });
    if (!o.email) return reply(409, { error: "no_email" });

    const [night] = await select<{ doors: string; last_entry: string }>(
      "hm_events?event_date=eq." + o.event_date + "&select=doors,last_entry");
    const [product] = await select<{ label: string }>("hm_products?code=eq." + o.product + "&select=label");
    const msg = ticketEmail({
      ticketCode: o.ticket_code,
      eventDate: o.event_date,
      doors: night?.doors || "17:00",
      lastEntry: night?.last_entry || "22:15",
      slot: o.slot,
      tickets: o.tickets,
      productLabel: product?.label || (o.tickets === 1 ? "One ticket" : o.tickets + " tickets"),
      amountCents: o.amount_cents,
      name: o.name,
      venueAddress: Deno.env.get("HM_VENUE_ADDRESS") || "",
      qrUrl: Deno.env.get("SUPABASE_URL") + "/functions/v1/hm-ticket?qr=" + encodeURIComponent(o.ticket_code),
    });
    const r = await sendEmail(o.email, msg);
    const patch = r.ok ? { email_sent_at: new Date().toISOString(), email_error: null } : { email_error: r.error || "send failed" };
    await rest("hm_orders?ticket_code=eq." + code, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=minimal" });
    return r.ok ? reply(200, { ok: true, to: o.email }) : reply(502, { error: r.error || "send failed" });
  } catch (e) {
    console.error("resend", code, (e as Error).message);
    return reply(500, { error: "server" });
  }
});
