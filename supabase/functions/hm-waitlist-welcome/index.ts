// Sends the waitlist confirmation, once, per signup.
//
// The signup itself is a direct PostgREST insert from the browser - there is
// no server step to hang this off - so the database calls this function from
// an AFTER INSERT trigger over pg_net. That ordering matters: the insert has
// already committed by the time this runs, so a mail failure can never cost
// the owner a name. The row is the record; the email is a courtesy on top.
//
// Idempotency lives in the database, not here: the trigger only fires for
// rows with welcome_sent_at IS NULL, and this stamps that column on success.
// A retry after a failed send is therefore safe and a double-send is not
// possible from a second trigger firing on the same row.

import { waitlistWelcomeEmail, sendEmail } from "../_shared/mail.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const HOOK_TOKEN = Deno.env.get("HM_HOOK_TOKEN") || "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Called only by the database. No CORS, no anon key path: a shared secret
  // the browser never sees is the whole authorisation story.
  if (!HOOK_TOKEN) return json({ error: "HM_HOOK_TOKEN not set" }, 500);
  if (req.headers.get("x-hm-hook") !== HOOK_TOKEN) return json({ error: "forbidden" }, 403);

  let row: { id?: string; name?: string | null; email?: string };
  try {
    row = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const id = (row.id || "").trim();
  const email = (row.email || "").trim();
  if (!id || !email) return json({ error: "id and email required" }, 400);

  const msg = waitlistWelcomeEmail(row.name ?? null);
  const sent = await sendEmail(email, msg);
  if (!sent.ok) {
    // Left unstamped on purpose so the row stays eligible for a retry.
    console.error("waitlist welcome failed", id, sent.error);
    return json({ ok: false, error: sent.error }, 502);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
  const { error } = await db
    .from("hm_waitlist")
    .update({ welcome_sent_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("welcome_sent_at stamp failed", id, error.message);

  return json({ ok: true });
});
