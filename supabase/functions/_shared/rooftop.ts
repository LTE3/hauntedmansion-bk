// The Graveyard - Hidden Rooftop (owner, 2026-10-08): free table
// reservations above the house, and the two emails that go with them.
// Composition only; sending is mail.ts's sendEmail.

import { BRAND, SITE, clock, nightLabel } from "./pay.ts";

export const ROOFTOP = "The Graveyard — Hidden Rooftop";
export const ROOFTOP_OPENS = 18; // 6 PM, every night the house is open
export const MAX_PARTY = 6;

// "00:00" is the end of the night, not its start: 24 sorts after 23.
export function hourOf(t: string): number {
  const h = Number(t.slice(0, 2));
  return h < 4 ? h + 24 : h;
}

// Rooftop times for a night: on the hour from 6 PM to the house's last entry.
export function rooftopTimes(houseSlots: string[]): string[] {
  if (!houseSlots.length) return [];
  const last = Math.max(...houseSlots.map(hourOf));
  const out: string[] = [];
  for (let h = ROOFTOP_OPENS; h <= last; h++) out.push(String(h % 24).padStart(2, "0") + ":00");
  return out;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function bookLink(eventDate?: string, ticketCode?: string | null): string {
  const q = new URLSearchParams();
  if (eventDate) q.set("d", eventDate);
  if (ticketCode) q.set("t", ticketCode);
  const s = q.toString();
  return SITE + "/rooftop.html" + (s ? "?" + s : "") + "#book";
}

// Shared shell: same card, palette and Outlook handling as the ticket email.
function shell(preheader: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
    @media only screen and (max-width:600px){ .card{padding:26px 20px !important} .h1{font-size:28px !important} }
  </style></head>
  <body style="margin:0;padding:0;background:#030202;color:#f3e8de;font-family:Georgia,'Times New Roman',serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#030202;">
    <tr><td align="center" style="padding:28px 14px 42px;">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#0b0807;border:1px solid #3a1512;border-radius:16px;overflow:hidden;">
        <tr><td bgcolor="#e33027" style="height:5px;background:#e33027;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td align="center" style="padding:26px 24px 0;">
          <img src="${SITE}/img/rooftop/graveyard-logo-email.png" width="360" alt="The Graveyard - Hidden Rooftop" style="display:block;width:100%;max-width:360px;height:auto;margin:0 auto;color:#f3e8de;font:700 22px/1.2 Georgia,serif;">
        </td></tr>
        <tr><td class="card" style="padding:22px 30px 32px;">${body}</td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
      <p style="margin:16px 0 0;font:500 11px/1.5 Arial,Helvetica,sans-serif;letter-spacing:.08em;color:#6f5d57;">HAUNTEDMANSIONBK.COM</p>
    </td></tr>
  </table></body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:26px 0 0;"><tr>
    <td bgcolor="#c8231b" align="center" style="border:1px solid #ff4c45;border-radius:8px;padding:15px 26px;mso-padding-alt:15px 26px;">
      <a href="${esc(href)}" style="display:inline-block;color:#fff1ea;font:700 14px/1 Arial,Helvetica,sans-serif;letter-spacing:.18em;text-transform:uppercase;text-decoration:none;">${label}</a>
    </td></tr></table>`;
}

const P = "margin:0 0 16px;font:400 17px/1.6 Georgia,'Times New Roman',serif;color:#e0d1c6;";
const KICK = "margin:0 0 10px;font:700 12px/1 Arial,Helvetica,sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#ff5b52;";

// Sent once after a paid ticket: the owner's copy, word for word.
export function rooftopPromoEmail(o: { eventDate: string; ticketCode: string; name: string | null }) {
  const link = bookLink(o.eventDate, o.ticketCode);
  const subject = "The Graveyard — the hidden rooftop above the house";
  const paras = [
    "Some secrets are better left buried. This one is worth discovering.",
    "Hidden above The Haunted Mansion lies The Graveyard, a mysterious open-air rooftop lounge where the night doesn’t end when the haunting does.",
    "Step into a world of eerie ambiance, hauntingly crafted drinks, delicious bites, and music beneath the night sky. Whether you’re looking to calm your nerves after surviving the mansion or start your evening with a few drinks, The Graveyard is your perfect escape.",
    "Enjoy intimate rooftop vibes during the week and a livelier atmosphere as the weekend takes over.",
    "Your experience doesn’t have to end at the exit.",
    "Reserve a table before or after your Haunted Mansion experience and discover what’s waiting above.",
  ];
  const text = [
    ROOFTOP.toUpperCase(), "",
    ...paras.flatMap((p) => [p, ""]),
    "The house is haunted. The rooftop is alive.", "",
    "Reserve a free table for " + nightLabel(o.eventDate) + " (up to 6 guests, pay as you order): " + link,
    "", SITE,
  ].join("\n");
  const html = shell("Reserve a free table at The Graveyard, the hidden rooftop above the house.", `
    <p style="${KICK}">Hidden rooftop · ${esc(BRAND)}</p>
    <h1 class="h1" style="margin:0 0 20px;font:700 32px/1.1 Georgia,'Times New Roman',serif;color:#f3e8de;">Some secrets are better left buried.</h1>
    <img src="${SITE}/img/rooftop/rooftop.jpg" width="500" alt="The Graveyard rooftop lounge at night" style="display:block;width:100%;max-width:500px;height:auto;margin:0 0 22px;border-radius:10px;">
    ${paras.slice(1).map((p) => `<p style="${P}">${esc(p)}</p>`).join("")}
    <p style="margin:6px 0 0;font:italic 700 19px/1.4 Georgia,'Times New Roman',serif;color:#ff5b52;">The house is haunted. The rooftop is alive.</p>
    ${button(link, "Book a table&nbsp; &rarr;")}
    <p style="margin:18px 0 0;font:500 13px/1.65 Arial,Helvetica,sans-serif;color:#9d8880;">Free reservation for ${esc(nightLabel(o.eventDate))}, from 6 PM. Up to 6 guests per table; you pay as you order. <a href="${SITE}/rooftop.html#menu" style="color:#c7aaa0;">See the menu</a>.</p>`);
  return { subject, html, text };
}

// Sent when a table is booked.
export function rooftopConfirmEmail(r: {
  code: string; eventDate: string; slot: string; party: number; name: string; venueAddress: string;
}) {
  const night = nightLabel(r.eventDate);
  const when = clock(r.slot);
  const subject = "Your table at The Graveyard — " + night + ", " + when;
  const rows: [string, string][] = [
    ["Night", night],
    ["Time", when],
    ["Table for", r.party === 1 ? "1 guest" : r.party + " guests"],
    ["Reservation", r.code],
    ...(r.venueAddress ? [["Where", r.venueAddress + " (rooftop)"] as [string, string]] : []),
  ];
  const text = [
    ROOFTOP, "", r.name + ", your table is reserved.", "",
    ...rows.map(([k, v]) => k + ": " + v), "",
    "Reservations are free. Pay for what you order on the rooftop.",
    "Menu: " + SITE + "/rooftop.html#menu", "", SITE,
  ].join("\n");
  const html = shell("Your table at The Graveyard is reserved: " + night + ", " + when + ".", `
    <p style="${KICK}">Table reserved</p>
    <h1 class="h1" style="margin:0 0 22px;font:700 32px/1.1 Georgia,'Times New Roman',serif;color:#f3e8de;">${esc(r.name)}, your table is waiting above the house.</h1>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid #39231f;">
      ${rows.map(([k, v]) => `<tr><td style="padding:12px 0;border-bottom:1px solid #39231f;font:600 12px/1.3 Arial,Helvetica,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#9d8880;width:38%;">${esc(k)}</td><td style="padding:12px 0;border-bottom:1px solid #39231f;font:400 17px/1.4 Georgia,serif;color:#f3e8de;">${esc(v)}</td></tr>`).join("")}
    </table>
    <p style="margin:22px 0 0;${P.replace("margin:0 0 16px;", "")}">The reservation is free. Pay for what you order on the rooftop.</p>
    ${button(SITE + "/rooftop.html#menu", "See the menu&nbsp; &rarr;")}
    <p style="margin:18px 0 0;font:500 13px/1.65 Arial,Helvetica,sans-serif;color:#9d8880;">Need to change or cancel? Reply to this email with your reservation code.</p>`);
  return { subject, html, text };
}
