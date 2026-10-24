// The Graveyard line (014_queue.sql): staff check parties in at The
// Graveyard and send them across to the house in groups of 15.
//
//   GET  /functions/v1/hm-queue?t=<ticket code>     a guest's own place in line
//   200: { state: "none" }
//      | { state: "waiting", ahead_people, ahead_groups, eff_slot, pushed, now_calling }
//      | { state: "called", group_no, called_at, now_calling }
//      | { state: "in", group_no }
//
//   POST /functions/v1/hm-queue        headers: x-hm-queue: <HM_QUEUE_TOKEN>
//   body: { op: "list" }                     tonight's line and called groups
//         { op: "find", q }                  search tonight's tickets: code, name, phone, email
//         { op: "checkin", code, force? }    force lets in a ticket for another night
//         { op: "call" }                     form and call the next group of 15
//         { op: "arrived", code, undo? }     marked at the house door
//         { op: "back", code }               called but not here: back of the line, as if checking in now
//         { op: "remove", code }             take out of the line altogether
//
// Deployed with --no-verify-jwt: the ticket code (unguessable) is the gate
// for GET, the staff token for POST. The token never moves money and never
// reads more than tonight's names, party sizes and entry times.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform); HM_QUEUE_TOKEN.

import { rest, rpc, select } from "../_shared/db.ts";
import { SITE, TICKET_CODE, TZ, timingSafeEqual } from "../_shared/pay.ts";

const ORIGINS = new Set([SITE, "http://127.0.0.1:8000", "http://localhost:8000"]);
const GROUP = 15;
const LATE_MIN = 10; // a called party has this long to reach the door

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.has(o) ? o : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hm-queue",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
}

function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface Q {
  ticket_code: string; event_date: string; party: number; slot_ts: string | null;
  checked_in_at: string; group_no: number | null; called_at: string | null; arrived_at: string | null;
}

// Same rule as hm_queue_eff() in SQL: on time (no later than 10 minutes after
// the entry time) keeps the entry time; later moves to the next session it
// can still make.
function eff(q: Q): number {
  const inAt = Date.parse(q.checked_in_at);
  if (!q.slot_ts) return inAt;
  const s = Date.parse(q.slot_ts), grace = 10 * 60000, half = 30 * 60000;
  return inAt <= s + grace ? s : s + half * Math.ceil((inAt - s - grace) / half);
}

function byLine(a: Q, b: Q): number {
  return eff(a) - eff(b) || Date.parse(a.checked_in_at) - Date.parse(b.checked_in_at) ||
    (a.ticket_code < b.ticket_code ? -1 : 1);
}

const hhmm = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ms));

async function tonight(): Promise<string> {
  return await rpc<string>("hm_tonight");
}

async function line(night: string): Promise<Q[]> {
  return await select<Q>("hm_queue?event_date=eq." + night + "&select=*");
}

async function guest(req: Request, code: string): Promise<Response> {
  const [me] = await select<Q>("hm_queue?ticket_code=eq." + code + "&select=*");
  if (!me) return reply(req, 200, { state: "none" });
  const all = await line(me.event_date);
  const nowCalling = all.reduce((m, q) => Math.max(m, q.group_no || 0), 0) || null;
  if (me.arrived_at) return reply(req, 200, { state: "in", group_no: me.group_no });
  if (me.group_no) return reply(req, 200, { state: "called", group_no: me.group_no, called_at: me.called_at, now_calling: nowCalling });
  const waiting = all.filter((q) => !q.group_no).sort(byLine);
  let ahead = 0;
  for (const q of waiting) {
    if (q.ticket_code === me.ticket_code) break;
    ahead += q.party;
  }
  const e = eff(me);
  return reply(req, 200, {
    state: "waiting",
    ahead_people: ahead,
    ahead_groups: Math.floor(ahead / GROUP),
    eff_slot: hhmm(e),
    pushed: !!me.slot_ts && e !== Date.parse(me.slot_ts),
    now_calling: nowCalling,
  });
}

interface Order { ticket_code: string; name: string | null; event_date: string; slot: string | null; tickets: number; status: string; phone: string | null }

async function staffList(night: string) {
  const all = await line(night);
  const codes = all.map((q) => q.ticket_code);
  const orders = codes.length
    ? await select<Order>("hm_orders?ticket_code=in.(" + codes.join(",") + ")&select=ticket_code,name,slot,tickets")
    : [];
  const name = new Map(orders.map((o) => [o.ticket_code, o.name || ""]));
  const now = Date.now();
  const row = (q: Q) => ({
    code: q.ticket_code, name: name.get(q.ticket_code) || "", party: q.party,
    slot: q.slot_ts ? hhmm(Date.parse(q.slot_ts)) : null, checked_in_at: q.checked_in_at,
    eff_slot: hhmm(eff(q)), pushed: !!q.slot_ts && eff(q) !== Date.parse(q.slot_ts),
    arrived_at: q.arrived_at,
    late: !q.arrived_at && !!q.called_at && now - Date.parse(q.called_at) > LATE_MIN * 60000,
  });
  const waiting = all.filter((q) => !q.group_no).sort(byLine).map(row);
  const groups = new Map<number, Q[]>();
  for (const q of all) if (q.group_no) groups.set(q.group_no, [...(groups.get(q.group_no) || []), q]);
  const called = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([g, qs]) => ({
    group_no: g, called_at: qs[0].called_at, people: qs.reduce((n, q) => n + q.party, 0), parties: qs.sort(byLine).map(row),
  }));
  const sold = await select<{ tickets: number }>("hm_orders?event_date=eq." + night + "&status=eq.paid&select=tickets");
  return {
    night, group_size: GROUP, late_minutes: LATE_MIN, now: new Date(now).toISOString(),
    waiting, called,
    totals: {
      tickets_tonight: sold.reduce((n, o) => n + o.tickets, 0),
      checked_in: all.reduce((n, q) => n + q.party, 0),
      waiting: waiting.reduce((n, q) => n + q.party, 0),
      arrived: all.filter((q) => q.arrived_at).reduce((n, q) => n + q.party, 0),
    },
  };
}

async function find(night: string, raw: string) {
  const s = raw.trim();
  const up = s.toUpperCase().replace(/\s/g, "");
  const code = TICKET_CODE.test(up) ? up : /^[0-9A-F]{8}$/.test(up) ? "HM-" + up : null;
  const fields = "&select=ticket_code,name,event_date,slot,tickets,status,phone&status=eq.paid&limit=15";
  let rows: Order[] = [];
  if (code) rows = await select<Order>("hm_orders?ticket_code=eq." + code + fields);
  if (!rows.length) {
    const digits = s.replace(/\D/g, "");
    const words = s.replace(/[^\p{L}\p{N} .'@-]/gu, "").trim();
    if (digits.length >= 4 && digits.length === s.replace(/[\s()+-]/g, "").length) {
      rows = await select<Order>("hm_orders?event_date=eq." + night + "&phone=like.*" + digits.slice(-10) + fields);
    } else if (words.length >= 2) {
      // Quoted, so a dot or space in the search cannot be read as PostgREST syntax.
      const pat = encodeURIComponent('"*' + words + '*"');
      rows = await select<Order>("hm_orders?event_date=eq." + night + "&or=(name.ilike." + pat + ",email.ilike." + pat + ")" + fields);
    }
  }
  const codes = rows.map((r) => r.ticket_code);
  const inLine = codes.length ? await select<Q>("hm_queue?ticket_code=in.(" + codes.join(",") + ")&select=*") : [];
  const state = new Map(inLine.map((q) => [q.ticket_code, q.arrived_at ? "in" : q.group_no ? "called" : "waiting"]));
  return rows.map((r) => ({
    code: r.ticket_code, name: r.name || "", night: r.event_date, slot: r.slot ? r.slot.slice(0, 5) : null,
    party: r.tickets, phone_last4: (r.phone || "").replace(/\D/g, "").slice(-4),
    other_night: r.event_date !== night, queue: state.get(r.ticket_code) || null,
  }));
}

async function patch(code: string, body: Record<string, unknown>) {
  await rest("hm_queue?ticket_code=eq." + code, { method: "PATCH", body: JSON.stringify(body), prefer: "return=minimal" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    if (req.method === "GET") {
      const t = new URL(req.url).searchParams.get("t") || "";
      if (!TICKET_CODE.test(t)) return reply(req, 400, { error: "bad_code" });
      return await guest(req, t);
    }
    if (req.method !== "POST") return reply(req, 405, { error: "method" });

    const want = Deno.env.get("HM_QUEUE_TOKEN");
    if (!want) return reply(req, 503, { error: "not_configured" });
    if (!timingSafeEqual(want, req.headers.get("x-hm-queue") || "")) {
      await new Promise((r) => setTimeout(r, 1000));
      return reply(req, 401, { error: "unauthorized" });
    }

    let b: { op?: unknown; q?: unknown; code?: unknown; force?: unknown; undo?: unknown };
    try {
      b = await req.json();
    } catch {
      return reply(req, 400, { error: "bad_request" });
    }
    const night = await tonight();
    const code = typeof b.code === "string" && TICKET_CODE.test(b.code) ? b.code : null;

    switch (b.op) {
      case "list":
        return reply(req, 200, await staffList(night));
      case "find":
        if (typeof b.q !== "string" || !b.q.trim()) return reply(req, 400, { error: "bad_request" });
        return reply(req, 200, { night, results: await find(night, b.q.slice(0, 80)) });
      case "checkin": {
        if (!code) return reply(req, 400, { error: "bad_code" });
        const r = await rpc<Record<string, unknown>>("hm_queue_checkin", { p_code: code, p_force: b.force === true });
        return reply(req, r.error ? 409 : 200, r);
      }
      case "call": {
        const g = await rpc<number | null>("hm_queue_call", { p_date: night, p_size: GROUP });
        return reply(req, 200, { group_no: g });
      }
      case "arrived":
        if (!code) return reply(req, 400, { error: "bad_code" });
        await patch(code, { arrived_at: b.undo === true ? null : new Date().toISOString() });
        return reply(req, 200, { ok: true });
      case "back":
        if (!code) return reply(req, 400, { error: "bad_code" });
        await patch(code, { group_no: null, called_at: null, arrived_at: null, checked_in_at: new Date().toISOString() });
        return reply(req, 200, { ok: true });
      case "remove":
        if (!code) return reply(req, 400, { error: "bad_code" });
        await rest("hm_queue?ticket_code=eq." + code, { method: "DELETE", prefer: "return=minimal" });
        return reply(req, 200, { ok: true });
      default:
        return reply(req, 400, { error: "bad_op" });
    }
  } catch (e) {
    console.error((e as Error).message);
    return reply(req, 500, { error: "server" });
  }
});
