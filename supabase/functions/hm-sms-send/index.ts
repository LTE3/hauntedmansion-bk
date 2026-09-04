// Text the waitlist - the only path that may.
//
//   POST /functions/v1/hm-sms-send
//   headers: x-hm-token: <HM_SMS_TOKEN>   (plus the usual apikey/Authorization
//                                          the gateway wants)
//   body:    { "message": "...",
//              "dry_run": true,             default true: count, compose, price, send nothing
//              "blast_id": "<uuid>",        optional: resume a blast that timed out
//              "limit": 400,                numbers per call; the rest are reported as remaining
//              "ignore_send_window": false  only with a reason you would say out loud
//            }
//
// What it refuses to do, in order:
//   * anything without the token - and with no token configured, anything at
//     all; there is no default open state;
//   * send to a number that hm_sms_recipients() does not return - that is the
//     consent stamp, the opt-out table and the mirrored flag, decided in one
//     place in SQL rather than re-decided here;
//   * send outside 11:00-20:59 Eastern (see _shared/sms.ts for why those
//     hours), unless told to ignore the window, in which case it says so in
//     the response and the log;
//   * send a message that does not name the sender and say how to stop; it
//     adds both when they are missing rather than refusing;
//   * send a number twice in one blast: every attempt is logged with the
//     blast id, and a resumed blast skips what is already there;
//   * text the numbers in HM_SMS_EXCLUDE (comma-separated E.164), for the
//     people running the house who are on the list to test it.
//
// What it reports: how many would be (or were) texted, the exact body, the
// segment count and encoding so the price is known before "dry_run": false,
// and per-number failures with the numbers masked. A Twilio 21610 (the
// carrier already has this number blocked) is recorded as an opt-out, so the
// list learns from it.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or
//      TWILIO_MESSAGING_SERVICE_SID; HM_SMS_TOKEN; HM_SMS_EXCLUDE (optional);
//      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (platform).

import { compose, mask, sendWindowOpen, segments, timingSafeEqual } from "../_shared/sms.ts";
import { insert, rpc, select, upsertIgnore } from "../_shared/db.ts";

const JSONH = { "Content-Type": "application/json" };
const BATCH = 10;          // concurrent posts to Twilio
const BATCH_GAP_MS = 1000; // between batches; Twilio queues beyond the number's rate anyway

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSONH });
}

type TwilioOk = { sid: string; status: string };
type TwilioErr = { code?: number; message?: string };
type Outcome = { phone: string; status: "queued" | "sent" | "failed" | "skipped-optout"; sid: string | null; error: string | null };

async function sendOne(phone: string, body: string): Promise<Outcome> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const auth = btoa(sid + ":" + Deno.env.get("TWILIO_AUTH_TOKEN")!);
  const form = new URLSearchParams({ To: phone, Body: body });
  const svc = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
  if (svc) form.set("MessagingServiceSid", svc);
  else form.set("From", Deno.env.get("TWILIO_FROM_NUMBER")!);

  const resp = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json", {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (resp.ok) {
    const ok = (await resp.json()) as TwilioOk;
    return { phone, status: ok.status === "sent" ? "sent" : "queued", sid: ok.sid, error: null };
  }
  const err = (await resp.json().catch(() => ({}))) as TwilioErr;
  const text = (err.code ? err.code + " " : "") + (err.message || "HTTP " + resp.status);
  if (err.code === 21610) return { phone, status: "skipped-optout", sid: null, error: text };
  return { phone, status: "failed", sid: null, error: text };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const want = Deno.env.get("HM_SMS_TOKEN");
  if (!want) return json(503, { error: "not configured: HM_SMS_TOKEN is not set" });
  if (!timingSafeEqual(want, req.headers.get("x-hm-token") || "")) return json(401, { error: "unauthorized" });

  let input: { message?: string; dry_run?: boolean; blast_id?: string; limit?: number; ignore_send_window?: boolean };
  try {
    input = await req.json();
  } catch {
    return json(400, { error: "body must be JSON" });
  }

  let body: string;
  try {
    body = compose(String(input.message ?? ""));
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
  const seg = segments(body);
  const dryRun = input.dry_run !== false;
  const limit = Math.min(Math.max(Number(input.limit) || 400, 1), 1000);
  const blastId = input.blast_id && /^[0-9a-f-]{36}$/i.test(input.blast_id) ? input.blast_id.toLowerCase() : crypto.randomUUID();
  const windowOpen = sendWindowOpen();
  const ignoreWindow = input.ignore_send_window === true;

  const exclude = new Set((Deno.env.get("HM_SMS_EXCLUDE") || "").split(",").map((s) => s.trim()).filter(Boolean));

  let recipients: string[];
  try {
    const rows = await rpc<{ phone: string }[]>("hm_sms_recipients");
    recipients = rows.map((r) => r.phone).filter((p) => !exclude.has(p));
    if (input.blast_id) {
      const done = await select<{ phone: string }>("hm_sms_log?blast_id=eq." + blastId + "&select=phone");
      const seen = new Set(done.map((d) => d.phone));
      recipients = recipients.filter((p) => !seen.has(p));
    }
  } catch (e) {
    return json(502, { error: (e as Error).message });
  }

  const batch = recipients.slice(0, limit);
  const summary = {
    blast_id: blastId,
    dry_run: dryRun,
    body,
    encoding: seg.encoding,
    units: seg.units,
    segments_per_message: seg.segments,
    eligible: recipients.length,
    this_call: batch.length,
    remaining_after_this_call: Math.max(recipients.length - batch.length, 0),
    send_window_open: windowOpen,
    ignore_send_window: ignoreWindow,
    excluded: exclude.size,
    sample: batch.slice(0, 3).map(mask),
  };

  if (dryRun) return json(200, { ...summary, note: "nothing sent; repeat with dry_run:false to send" });
  if (!windowOpen && !ignoreWindow) {
    return json(425, { ...summary, error: "outside the 11:00-20:59 Eastern send window; nothing sent" });
  }
  if (batch.length === 0) return json(200, { ...summary, sent: 0, queued: 0, failed: 0, skipped_optout: 0, errors: [] });

  const outcomes: Outcome[] = [];
  for (let i = 0; i < batch.length; i += BATCH) {
    const slice = batch.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map((p) => sendOne(p, body)));
    const rows: Outcome[] = results.map((r, j) =>
      r.status === "fulfilled" ? r.value : { phone: slice[j], status: "failed", sid: null, error: String((r as PromiseRejectedResult).reason?.message || r.reason) }
    );
    outcomes.push(...rows);
    try {
      await insert("hm_sms_log", rows.map((o) => ({
        blast_id: blastId, phone: o.phone, body, twilio_sid: o.sid, status: o.status,
        error: o.error ? (ignoreWindow ? "[outside send window] " : "") + o.error : (ignoreWindow ? "[outside send window]" : null),
      })));
      for (const o of rows) {
        if (o.status === "skipped-optout") await upsertIgnore("hm_sms_optout", { phone: o.phone, via: "twilio-21610", body: o.error });
      }
    } catch (e) {
      // The texts in this batch are already with Twilio. Stop here rather than
      // carry on without a record; the response says how far it got and the
      // same blast_id resumes from the log.
      return json(500, {
        ...summary,
        error: "sent " + outcomes.length + " but failed to log the last " + rows.length + ": " + (e as Error).message,
        sent: outcomes.filter((o) => o.status === "sent" || o.status === "queued").length,
      });
    }
    if (i + BATCH < batch.length) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
  }

  const count = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  return json(200, {
    ...summary,
    sent: count("sent"),
    queued: count("queued"),
    failed: count("failed"),
    skipped_optout: count("skipped-optout"),
    errors: outcomes.filter((o) => o.error).slice(0, 20).map((o) => ({ phone: mask(o.phone), status: o.status, error: o.error })),
  });
});
