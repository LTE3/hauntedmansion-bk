// Twilio's webhook for texts that arrive at the house number.
//
// Point the number's "A message comes in" webhook at
//   https://<project>.supabase.co/functions/v1/hm-sms-inbound
// and deploy with --no-verify-jwt: Twilio cannot send a Supabase JWT, and it
// does not need to, because every request it sends is signed with the
// account's auth token and the signature is checked here before anything is
// read from the body. A request that fails the check gets a 403 and leaves no
// trace in the database.
//
// What it does with a genuine one:
//   * logs it to hm_sms_inbound, keyword or not - the FCC counts any
//     reasonable wording as a revocation, so a human has to be able to read
//     the ones that did not match;
//   * STOP (and its cousins) -> a row in hm_sms_optout, which a trigger mirrors
//     onto the waitlist. From that moment hm_sms_recipients() no longer
//     returns the number;
//   * START -> the opt-out row is deleted, and the mirror clears the stamp;
//   * HELP -> a help text, when this side is the one replying.
//
// Replying. Twilio's own opt-out handling is on by default for US numbers: it
// answers STOP and HELP itself and forwards the message here as well. In that
// setup this function must not answer too, or the person gets two texts, so
// it returns an empty <Response/>. If that handling is turned off on the
// number, set HM_SMS_SELF_REPLY=1 and the replies in _shared/sms.ts go out
// from here instead. One or the other, never both.
//
// Env: TWILIO_AUTH_TOKEN (already set for the other text functions),
//      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided by the platform),
//      HM_SMS_INBOUND_URL (optional: the exact public URL Twilio was given, if
//      it differs from what the runtime sees), HM_SMS_SELF_REPLY (optional),
//      HM_SMS_HELP_CONTACT (optional: how to reach us, for the HELP text).

import {
  e164, helpReply, keyword, mask, START_REPLY, STOP_REPLY, timingSafeEqual, twilioSignature, twimlBody,
} from "../_shared/sms.ts";
import { insert, rest, upsertIgnore } from "../_shared/db.ts";

const XML = { "Content-Type": "text/xml; charset=utf-8" };

function twiml(message?: string): Response {
  return new Response(twimlBody(message), { headers: XML });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!token) return new Response("not configured", { status: 503 });

  // Twilio signs the decoded form values; URLSearchParams decodes the same way.
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  const url = Deno.env.get("HM_SMS_INBOUND_URL") || req.url;
  const expected = await twilioSignature(token, url, params);
  const given = req.headers.get("x-twilio-signature") || "";
  if (!timingSafeEqual(expected, given)) return new Response("forbidden", { status: 403 });

  const from = e164(params.From || "");
  const body = (params.Body || "").slice(0, 1600);
  const kw = keyword(body);

  try {
    await insert("hm_sms_inbound", {
      from_phone: from ?? (params.From || null),
      to_phone: params.To || null,
      body,
      keyword: kw,
      twilio_sid: params.MessageSid || null,
    });
    if (from && kw === "stop") {
      await upsertIgnore("hm_sms_optout", { phone: from, via: "stop", body });
    } else if (from && kw === "start") {
      await rest("hm_sms_optout?phone=eq." + encodeURIComponent(from), { method: "DELETE", prefer: "return=minimal" });
    }
  } catch (err) {
    // Twilio retries a 5xx, and a retry is exactly what an opt-out that failed
    // to record deserves. The message body stays out of the log line.
    console.error("inbound", kw, from ? mask(from) : "?", (err as Error).message);
    return new Response("try again", { status: 500 });
  }

  const self = Deno.env.get("HM_SMS_SELF_REPLY") === "1";
  if (!self) return twiml();
  if (kw === "stop") return twiml(STOP_REPLY);
  if (kw === "start") return twiml(START_REPLY);
  if (kw === "help") return twiml(helpReply(Deno.env.get("HM_SMS_HELP_CONTACT") || undefined));
  return twiml();
});
