// Start a purchase: one Stripe Checkout Session for one night and one product.
//
//   POST /functions/v1/hm-create-checkout
//   headers: the usual apikey/Authorization the gateway wants (anon is fine)
//   body:    { "event_date": "2026-10-01", "product": "pair",
//              "email": "optional@example.com", "tag": "optional-channel-tag" }
//   200:     { "url": "https://checkout.stripe.com/...", "id": "cs_..." }
//   400/404/409: { "error": "bad_request" | "unknown_night" | "unknown_product"
//                           | "not_on_sale" | "sold_out" }
//
// What it refuses to do:
//   * sell a night that is not one of the nineteen, or is not switched on;
//   * sell more seats than the night has left (a pre-check; the webhook checks
//     again at payment, because two people can pass this at once);
//   * trust a price from the browser: the product row is the price.
//
// The pending order row is written after Stripe accepts the session, so the
// webhook has something to confirm; if that write fails the webhook inserts
// the row itself from the session's metadata.
//
// Env: HM_STRIPE_SECRET_KEY (test until the owner says live); SUPABASE_URL and
//      SUPABASE_SERVICE_ROLE_KEY (platform).

import { insert, select } from "../_shared/db.ts";
import { BRAND, SITE, formEncode, isNight, nightLabel, validEmail } from "../_shared/pay.ts";

const ORIGINS = new Set([SITE, "http://127.0.0.1:8000", "http://localhost:8000"]);

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

interface Product { code: string; label: string; tickets: number; cents: number; is_active: boolean }
interface Night { event_date: string; capacity: number; sold: number; is_active: boolean }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return reply(req, 405, { error: "method" });

  let body: { event_date?: unknown; product?: unknown; email?: unknown; tag?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply(req, 400, { error: "bad_request" });
  }

  const date = typeof body.event_date === "string" ? body.event_date : "";
  const code = typeof body.product === "string" ? body.product : "";
  const email = validEmail(body.email) ? body.email : null;
  const tag = typeof body.tag === "string" ? body.tag.replace(/[^\w.-]/g, "").slice(0, 40) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isNight(date)) return reply(req, 404, { error: "unknown_night" });
  if (!/^[a-z_]{1,20}$/.test(code)) return reply(req, 400, { error: "bad_request" });

  const key = Deno.env.get("HM_STRIPE_SECRET_KEY");
  if (!key) return reply(req, 500, { error: "not_configured" });

  try {
    const [product] = await select<Product>("hm_products?code=eq." + code + "&is_active=is.true&select=code,label,tickets,cents,is_active");
    if (!product) return reply(req, 404, { error: "unknown_product" });

    const [night] = await select<Night>("hm_events?event_date=eq." + date + "&select=event_date,capacity,sold,is_active");
    if (!night) return reply(req, 404, { error: "unknown_night" });
    if (!night.is_active) return reply(req, 409, { error: "not_on_sale" });
    if (night.sold + product.tickets > night.capacity) return reply(req, 409, { error: "sold_out" });

    const label = nightLabel(date);
    const params = {
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: product.cents,
          product_data: {
            name: BRAND + " — " + label,
            description: product.label + (product.tickets === 1 ? " · admits one" : " · admits " + product.tickets),
          },
        },
      }],
      metadata: { brand: "hm", event_date: date, product: product.code, tickets: product.tickets, tag },
      payment_intent_data: {
        description: BRAND + " · " + label + " · " + product.label,
        metadata: { brand: "hm", event_date: date, product: product.code, tickets: product.tickets },
      },
      customer_email: email,
      allow_promotion_codes: true,
      success_url: SITE + "/ticket.html?s={CHECKOUT_SESSION_ID}",
      cancel_url: SITE + "/nights.html",
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    };

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: formEncode(params),
      signal: AbortSignal.timeout(20000),
    });
    const session = await resp.json() as { id?: string; url?: string; livemode?: boolean; amount_total?: number; error?: { message?: string; type?: string } };
    if (!resp.ok || !session.id || !session.url) {
      console.error("stripe", resp.status, session.error?.type, session.error?.message);
      return reply(req, 502, { error: "payment_provider" });
    }

    try {
      await insert("hm_orders", {
        stripe_session_id: session.id,
        livemode: session.livemode ?? null,
        event_date: date,
        product: product.code,
        tickets: product.tickets,
        amount_cents: session.amount_total ?? product.cents,
        email,
        tag,
        status: "pending",
      });
    } catch (e) {
      // The webhook will create the row from metadata; say so in the log.
      console.error("pending row not written", (e as Error).message);
    }

    return reply(req, 200, { url: session.url, id: session.id });
  } catch (e) {
    console.error((e as Error).message);
    return reply(req, 500, { error: "server" });
  }
});
