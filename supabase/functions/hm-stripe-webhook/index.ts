// The one place a purchase becomes a ticket. Stripe calls this; nothing else
// should, and nothing else can without the signing secret.
//
//   POST /functions/v1/hm-stripe-webhook      (deployed with --no-verify-jwt:
//                                              Stripe sends no Supabase JWT)
//   headers: Stripe-Signature
//
// In order:
//   1. verify the signature over the raw body; anything that fails is 400 and
//      nothing is written;
//   2. ignore anything not tagged metadata.brand = "hm" - this Stripe account
//      is shared with La Casita and its events arrive here too;
//   3. checkout.session.completed with payment_status paid:
//        hm_confirm_order() in the database does the counting under a row
//        lock and returns paid / already / oversold / unknown; on unknown the
//        pending row is created from the session's metadata and the call is
//        made once more;
//        on paid, the ticket email is sent (Resend) and its result recorded
//        on the order; a failed email never fails the order;
//   4. checkout.session.expired marks a pending order expired;
//   5. charge.refunded gives the seats back (hm_release_order).
//
// Stripe retries anything that is not a 2xx. So: 200 for everything that was
// handled or deliberately ignored, 500 only when the database was unreachable
// (the retry is then wanted, and the counting is idempotent).
//
// Env: HM_STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, HM_EMAIL_FROM (optional in
//      test), HM_VENUE_ADDRESS (the only place the address exists);
//      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (platform).

import { insert, rest, rpc, select } from "../_shared/db.ts";
import { sendEmail, ticketEmail } from "../_shared/mail.ts";
import { isNight, verifyStripeSignature } from "../_shared/pay.ts";

const JSONH = { "Content-Type": "application/json" };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: JSONH });

interface Session {
  id: string;
  livemode?: boolean;
  payment_status?: string;
  payment_intent?: string | null;
  amount_total?: number | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  customer_email?: string | null;
  metadata?: Record<string, string> | null;
}
interface Order {
  stripe_session_id: string; event_date: string; product: string; tickets: number;
  amount_cents: number; email: string | null; name: string | null; ticket_code: string | null; status: string;
}
interface Night { doors: string; last_entry: string }
interface Product { label: string }

async function confirm(s: Session, eventId: string): Promise<string> {
  const args = {
    p_session_id: s.id,
    p_event_id: eventId,
    p_payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : null,
    p_livemode: s.livemode ?? null,
    p_email: s.customer_details?.email || s.customer_email || null,
    p_name: s.customer_details?.name || null,
    p_amount_cents: typeof s.amount_total === "number" ? s.amount_total : null,
  };
  let result = await rpc<string>("hm_confirm_order", args);
  if (result === "unknown") {
    // Session created, pending row never landed. Rebuild it from metadata,
    // which was set server-side by hm-create-checkout and cannot be edited by
    // the buyer.
    const m = s.metadata || {};
    const tickets = Number(m.tickets);
    if (!isNight(m.event_date || "") || !/^[a-z_]{1,20}$/.test(m.product || "") || !(tickets >= 1 && tickets <= 6)) {
      return "unknown";
    }
    await insert("hm_orders", {
      stripe_session_id: s.id,
      livemode: s.livemode ?? null,
      event_date: m.event_date,
      product: m.product,
      tickets,
      amount_cents: s.amount_total ?? 0,
      email: args.p_email,
      name: args.p_name,
      tag: m.tag || null,
      status: "pending",
    });
    result = await rpc<string>("hm_confirm_order", args);
  }
  return result;
}

async function email(sessionId: string): Promise<void> {
  const [o] = await select<Order>("hm_orders?stripe_session_id=eq." + encodeURIComponent(sessionId) +
    "&select=stripe_session_id,event_date,product,tickets,amount_cents,email,name,ticket_code,status");
  if (!o || o.status !== "paid" || !o.ticket_code) return;
  const note = async (patch: Record<string, unknown>) => {
    await rest("hm_orders?stripe_session_id=eq." + encodeURIComponent(sessionId), {
      method: "PATCH", body: JSON.stringify(patch), prefer: "return=minimal",
    });
  };
  if (!o.email) { await note({ email_error: "no email on session" }); return; }

  try {
    const [night] = await select<Night>("hm_events?event_date=eq." + o.event_date + "&select=doors,last_entry");
    const [product] = await select<Product>("hm_products?code=eq." + o.product + "&select=label");
    const fnBase = Deno.env.get("SUPABASE_URL") + "/functions/v1";
    const msg = ticketEmail({
      ticketCode: o.ticket_code,
      eventDate: o.event_date,
      doors: night?.doors || "17:00",
      lastEntry: night?.last_entry || "22:15",
      tickets: o.tickets,
      productLabel: product?.label || (o.tickets === 1 ? "One ticket" : o.tickets + " tickets"),
      amountCents: o.amount_cents,
      name: o.name,
      venueAddress: Deno.env.get("HM_VENUE_ADDRESS") || "",
      qrUrl: fnBase + "/hm-ticket?qr=" + encodeURIComponent(o.ticket_code),
    });
    const r = await sendEmail(o.email, msg);
    if (r.ok) await note({ email_sent_at: new Date().toISOString(), email_error: null });
    else await note({ email_error: r.error || "send failed" });
  } catch (e) {
    await note({ email_error: String((e as Error).message).slice(0, 300) });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const secret = Deno.env.get("HM_STRIPE_WEBHOOK_SECRET") || "";
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret))) {
    return new Response(JSON.stringify({ error: "signature" }), { status: 400, headers: JSONH });
  }

  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: "json" }), { status: 400, headers: JSONH });
  }

  const obj = event.data?.object || {};
  const meta = (obj.metadata || {}) as Record<string, string>;
  if (meta.brand !== "hm") return ok({ received: true, ignored: "not hm" });

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = obj as unknown as Session;
        if (s.payment_status !== "paid") return ok({ received: true, ignored: "unpaid" });
        const result = await confirm(s, event.id);
        if (result === "paid") await email(s.id);
        if (result === "oversold") console.error("OVERSOLD session", s.id, meta.event_date, "tickets", meta.tickets);
        return ok({ received: true, result });
      }
      case "checkout.session.expired": {
        const s = obj as unknown as Session;
        await rest("hm_orders?stripe_session_id=eq." + encodeURIComponent(s.id) + "&status=eq.pending", {
          method: "PATCH", body: JSON.stringify({ status: "expired", expired_at: new Date().toISOString() }), prefer: "return=minimal",
        });
        return ok({ received: true, result: "expired" });
      }
      case "charge.refunded": {
        const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : "";
        if (!pi) return ok({ received: true, ignored: "no payment_intent" });
        const [o] = await select<{ stripe_session_id: string }>(
          "hm_orders?stripe_payment_intent=eq." + encodeURIComponent(pi) + "&select=stripe_session_id");
        if (!o) return ok({ received: true, ignored: "no order" });
        const released = await rpc<boolean>("hm_release_order", { p_session_id: o.stripe_session_id, p_status: "refunded" });
        return ok({ received: true, result: released ? "refunded" : "already" });
      }
      default:
        return ok({ received: true, ignored: event.type });
    }
  } catch (e) {
    console.error(event.type, (e as Error).message);
    return new Response(JSON.stringify({ error: "server" }), { status: 500, headers: JSONH });
  }
});
