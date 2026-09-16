// The ticket email: the one place the venue's street address is ever written
// for a guest. The address is not in this file; it arrives as an argument,
// read by the webhook from a secret, so the repo never holds it and a
// missing secret produces no email rather than an email with a blank.
//
// Composition is pure (tested under Node); sending is Gmail SMTP via
// denomailer. The denomailer import is loaded lazily, inside sendEmail,
// so importing this module for ticketEmail alone - which is all the Node
// test suite does - never touches a Deno global or a remote import.

import { BRAND, SITE, clock, money, nightLabel } from "./pay.ts";

export interface TicketDetails {
  ticketCode: string;
  eventDate: string;     // YYYY-MM-DD
  doors: string;         // Postgres time
  lastEntry: string;
  tickets: number;
  productLabel: string;
  amountCents: number;
  name: string | null;
  venueAddress: string;  // required: no address, no email
  qrUrl: string;         // image the mail client fetches
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function ticketEmail(t: TicketDetails): { subject: string; html: string; text: string } {
  if (!t.venueAddress || !t.venueAddress.trim()) throw new Error("venue address not configured");
  const night = nightLabel(t.eventDate);
  const people = t.tickets === 1 ? "1 guest" : t.tickets + " guests";
  const link = SITE + "/ticket.html?t=" + encodeURIComponent(t.ticketCode);
  const subject = BRAND + " — " + night;

  const rows: [string, string][] = [
    ["Night", night],
    ["Doors", clock(t.doors)],
    ["Last entry", clock(t.lastEntry)],
    ["Admits", people + " (" + t.productLabel.toLowerCase() + ")"],
    ["Paid", money(t.amountCents)],
    ["Where", t.venueAddress],
  ];

  const text = [
    BRAND,
    "",
    (t.name ? t.name + ", y" : "Y") + "our night is set.",
    "",
    ...rows.map(([k, v]) => k + ": " + v),
    "",
    "Your code: " + t.ticketCode,
    "Show it at the door, on your phone or printed: " + link,
    "",
    "13 and over. Guests under 18 must be accompanied by an adult. All sales are final.",
    SITE,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#030202;color:#f3e8de;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:520px;margin:0 auto;padding:32px 20px;">
  <p style="margin:0 0 6px;font:600 12px/1 Arial,Helvetica,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#b9aaa1;">${esc(BRAND)}</p>
  <h1 style="margin:0 0 24px;font:400 30px/1.15 Georgia,serif;color:#f3e8de;">${esc((t.name ? t.name + ", y" : "Y") + "our night is set.")}</h1>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font:500 15px/1.5 Arial,Helvetica,sans-serif;">
    ${rows.map(([k, v]) => `<tr>
      <td style="padding:10px 0;border-top:1px solid rgba(255,255,255,.14);color:#b9aaa1;vertical-align:top;width:34%;">${esc(k)}</td>
      <td style="padding:10px 0;border-top:1px solid rgba(255,255,255,.14);color:#f3e8de;">${esc(v)}</td>
    </tr>`).join("")}
  </table>
  <div style="margin:28px 0 8px;padding:20px;border:1px solid rgba(255,255,255,.14);text-align:center;">
    <p style="margin:0 0 6px;font:600 12px/1 Arial,Helvetica,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#b9aaa1;">Your code</p>
    <p style="margin:0 0 14px;font:700 30px/1 'Courier New',Courier,monospace;letter-spacing:.08em;color:#ff594e;">${esc(t.ticketCode)}</p>
    <img src="${esc(t.qrUrl)}" width="220" height="220" alt="${esc(t.ticketCode)}" style="display:block;margin:0 auto;background:#fff;padding:8px;">
    <p style="margin:14px 0 0;font:500 13px/1.5 Arial,Helvetica,sans-serif;color:#cfc2b8;">Show it at the door, on your phone or printed.<br><a href="${esc(link)}" style="color:#ff594e;">Open your ticket</a></p>
  </div>
  <p style="margin:24px 0 0;font:500 13px/1.6 Arial,Helvetica,sans-serif;color:#b9aaa1;">13 and over. Guests under 18 must be accompanied by an adult. All sales are final.<br><a href="${SITE}" style="color:#b9aaa1;">hauntedmansionbk.com</a></p>
</div></body></html>`;

  return { subject, html, text };
}

// The waitlist confirmation. Deliberately thin: a list signup is not a
// purchase, and the only promise made on the form is that we write once when
// tickets go on sale. Every factual line here is already on the site - the
// opening line from the home page, the age rule in the frozen wording it has
// in all eleven other places, and the removal address privacy.html:226
// already tells people to use. Nothing new is asserted in a guest's inbox.
export function waitlistWelcomeEmail(name: string | null): { subject: string; html: string; text: string } {
  const who = (name || "").trim();
  const greet = who ? esc(who) + ", your name is on the list." : "Your name is on the list.";
  const subject = BRAND + " — your name is on the list";

  const text = [
    who ? who + ", your name is on the list." : "Your name is on the list.",
    "",
    "A house in Bushwick, Brooklyn opens October 1, 2026.",
    "",
    "Names on this list hear first when tickets go on sale. That is the only",
    "reason we will write to you.",
    "",
    "13 and over. Guests under 18 must be accompanied by an adult.",
    "",
    "To come off the list, or to be told what we hold about you, write to",
    "admin@pulsetix.ai.",
    "",
    SITE,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#030202;color:#f3e8de;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <p style="margin:0 0 28px;font:700 13px/1 Arial,Helvetica,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#c2702f;">${esc(BRAND)}</p>
    <p style="margin:0 0 24px;font:400 26px/1.25 Georgia,'Times New Roman',serif;color:#f3e8de;">${greet}</p>
    <p style="margin:0 0 20px;font:400 16px/1.6 Georgia,'Times New Roman',serif;color:#d8c9bd;">A house in Bushwick, Brooklyn opens October 1, 2026.</p>
    <p style="margin:0 0 20px;font:400 16px/1.6 Georgia,'Times New Roman',serif;color:#d8c9bd;">Names on this list hear first when tickets go on sale. That is the only reason we will write to you.</p>
    <p style="margin:32px 0 0;padding-top:20px;border-top:1px solid #241d18;font:500 13px/1.6 Arial,Helvetica,sans-serif;color:#b9aaa1;">13 and over. Guests under 18 must be accompanied by an adult.</p>
    <p style="margin:12px 0 0;font:500 13px/1.6 Arial,Helvetica,sans-serif;color:#b9aaa1;">To come off the list, or to be told what we hold about you, write to <a href="mailto:admin@pulsetix.ai" style="color:#b9aaa1;">admin@pulsetix.ai</a>.<br><a href="${SITE}" style="color:#b9aaa1;">hauntedmansionbk.com</a></p>
  </div></body></html>`;

  return { subject, html, text };
}


// Gmail SMTP, same pattern already running in production for La Casita (this
// repo's owner's other business, same Supabase project): GMAIL_USER /
// GMAIL_APP_PASSWORD secrets, denomailer, from-name swapped for this brand.
// This is the default path - buyers were previously getting nothing, because
// the old Resend path fell back to Resend's sandbox sender (onboarding@
// resend.dev), which only ever delivers to the Resend account owner.
async function sendViaGmail(
  to: string,
  msg: { subject: string; html: string; text: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  // This Supabase project is shared with the owner's other business, and
  // GMAIL_USER/GMAIL_APP_PASSWORD are that business's mailbox - its own
  // functions send "La Casita BK <${GMAIL_USER}>" from them. Borrowing that
  // mailbox would put a haunted-house ticket in a guest's inbox from a
  // restaurant's address. HM_GMAIL_* is this brand's own sender
  // (admin@pulsetix.ai); the shared pair stays only as a fallback so nothing
  // silently stops sending if HM_GMAIL_* is not set yet.
  const user = Deno.env.get("HM_GMAIL_USER") || Deno.env.get("GMAIL_USER") || "";
  const pass = Deno.env.get("HM_GMAIL_APP_PASSWORD") || Deno.env.get("GMAIL_APP_PASSWORD") || "";
  if (!user || !pass) return { ok: false, error: "HM_GMAIL_USER/HM_GMAIL_APP_PASSWORD not set" };

  const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: user, password: pass },
    },
  });
  try {
    await client.send({
      from: `${BRAND} <${user}>`,
      to,
      subject: msg.subject,
      html: msg.html,
      content: msg.text,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "gmail smtp: " + String((e as Error).message).slice(0, 200) };
  } finally {
    await client.close().catch(() => {});
  }
}

// Resend: kept as an override, not deleted, because it is the only sane way
// to send from a branded domain (hauntedmansionbk.com) rather than a raw
// Gmail address - Gmail SMTP can only send as the authenticated Gmail
// account, it cannot send as an arbitrary verified domain. Set HM_EMAIL_FROM
// once that domain is verified in Resend and mail switches to it with no
// other code change; until then it stays off and Gmail SMTP is what ships.
async function sendViaResend(
  from: string,
  to: string,
  msg: { subject: string; html: string; text: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY") || "";
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: msg.subject, html: msg.html, text: msg.text }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, error: "resend " + resp.status + ": " + String((body as { message?: string }).message || "").slice(0, 200) };
  return { ok: true, id: (body as { id?: string }).id };
}

export async function sendEmail(
  to: string,
  msg: { subject: string; html: string; text: string },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const from = Deno.env.get("HM_EMAIL_FROM") || "";
  if (from) return sendViaResend(from, to, msg);
  return sendViaGmail(to, msg);
}
