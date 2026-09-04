// The database, through PostgREST, as the service role. Only the edge
// functions hold that key; it never reaches a page. Every table this touches
// has RLS on and no anon grants (005_sms_consent.sql), so this is the only way
// in, and this code is the whole of who is allowed through.

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error("missing env " + name);
  return v;
}

export async function rest(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
  const url = env("SUPABASE_URL") + "/rest/v1/" + path;
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers.Prefer = init.prefer;
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error("db " + resp.status + " on " + path.split("?")[0] + ": " + text.slice(0, 300));
  }
  return resp;
}

export async function insert(table: string, rows: unknown, prefer = "return=minimal"): Promise<void> {
  await rest(table, { method: "POST", body: JSON.stringify(rows), prefer });
}

// Insert-or-ignore on the primary key, for tables where the first record is
// the one that counts (an opt-out keeps its original time).
export async function upsertIgnore(table: string, row: unknown): Promise<void> {
  await rest(table, { method: "POST", body: JSON.stringify(row), prefer: "return=minimal,resolution=ignore-duplicates" });
}

export async function select<T>(pathWithQuery: string): Promise<T[]> {
  const resp = await rest(pathWithQuery);
  return (await resp.json()) as T[];
}

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const resp = await rest("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });
  return (await resp.json()) as T;
}
