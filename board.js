/* The Graveyard screen. Reads the staff list every 5 s and shows the newest
   called group (while its 10 minutes last) and the people who make up the
   next group. Same key handling as queue.js; text only via textContent. */
(function () {
  const API = "https://tqeunmqnaoyrerkbhokk.supabase.co/functions/v1/hm-queue";
  const KEY_NAME = "hm_queue_key";
  const REFRESH_MS = 5000;
  const SHOW_MS = 10 * 60000;
  const $ = id => document.getElementById(id);

  let key = "";
  try { key = localStorage.getItem(KEY_NAME) || ""; } catch (e) {}
  const m = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  if (m) {
    try { key = decodeURIComponent(m[1]); } catch (e) { key = m[1]; }
    try { localStorage.setItem(KEY_NAME, key); } catch (e) {}
  }
  if (location.hash) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }

  const noKey = () => { $("board").hidden = true; $("nokey").hidden = false; };

  // "Jordan Lee" -> "Jordan L.": enough to spot yourself, not a full name on a wall.
  const short = n => {
    const w = String(n || "").trim().split(/\s+/).filter(Boolean);
    if (!w.length) return "Guest";
    return w.length > 1 ? w[0] + " " + w[w.length - 1][0] + "." : w[0];
  };

  const fill = (ul, rows) => {
    ul.textContent = "";
    for (const r of rows) {
      const li = document.createElement("li");
      li.textContent = short(r.name);
      const s = document.createElement("span");
      s.textContent = "×" + r.party;
      li.append(s);
      ul.append(li);
    }
  };

  let shown = null;
  const render = d => {
    const now = Date.parse(d.now) || Date.now();
    const g = (d.called || [])[0];
    const live = !!g && now - Date.parse(g.called_at) < SHOW_MS;
    const sec = $("now");
    $("group").textContent = live ? "Group " + g.group_no : "—";
    fill($("names"), live ? g.parties.filter(p => !p.arrived_at) : []);
    $("go").hidden = !live;
    if (live && shown !== g.group_no) {
      sec.classList.remove("fresh"); void sec.offsetWidth; sec.classList.add("fresh");
    }
    shown = live ? g.group_no : null;

    // The next call takes parties from the front up to the group size,
    // skipping one that would overflow (as hm_queue_call does).
    const size = d.group_size || 15, next = [];
    let total = 0;
    for (const p of d.waiting || []) {
      if (total === 0 || total + p.party <= size) { next.push(p); total += p.party; }
      if (total >= size) break;
    }
    fill($("next"), next);
    $("next-empty").hidden = next.length > 0;
  };

  const clock = () => {
    $("clock").textContent = new Intl.DateTimeFormat("en-US",
      { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date());
  };

  async function refresh() {
    try {
      const res = await fetch(API, {
        method: "POST", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", "x-hm-queue": key },
        body: JSON.stringify({ op: "list" })
      });
      if (res.status === 401) { try { localStorage.removeItem(KEY_NAME); } catch (e) {} noKey(); return; }
      if (res.ok) render(await res.json());
    } catch (e) { /* keep what is on screen; the next tick retries */ }
  }

  if (!key) { noKey(); return; }
  $("board").hidden = false;
  clock(); setInterval(clock, 15000);
  refresh(); setInterval(refresh, REFRESH_MS);
})();
