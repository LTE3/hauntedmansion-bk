/* Graveyard line - staff phone page. Talks only to hm-queue; the staff token
   goes in the x-hm-queue header and nowhere else. All data is written with
   textContent. */
(function () {
  const API = "https://tqeunmqnaoyrerkbhokk.supabase.co/functions/v1/hm-queue";
  const KEY_NAME = "hm_queue_key";
  const REFRESH_MS = 5000;
  const ARM_MS = 4000;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const $ = id => document.getElementById(id);
  const els = {
    nokey: $("nokey"), app: $("app"), sync: $("sync"), call: $("call"), calledMsg: $("called-msg"),
    tIn: $("t-in"), tWait: $("t-wait"), tHouse: $("t-house"), tSold: $("t-sold"),
    search: $("search"), q: $("q"), findNote: $("find-note"), results: $("results"),
    waiting: $("waiting"), waitingEmpty: $("waiting-empty"), waitingCount: $("waiting-count"),
    called: $("called"), calledEmpty: $("called-empty"), toast: $("toast")
  };

  /* ---------- key ---------- */
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

  function showNoKey() {
    key = "";
    try { localStorage.removeItem(KEY_NAME); } catch (e) {}
    els.app.hidden = true;
    els.nokey.hidden = false;
    els.sync.textContent = "Not signed in";
    els.sync.className = "sync bad";
  }

  /* ---------- api ---------- */
  class AuthError extends Error {}
  async function api(body) {
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hm-queue": key },
        body: JSON.stringify(body),
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
    } catch (e) {
      const err = new Error("network"); err.network = true; throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) { showNoKey(); throw new AuthError("unauthorized"); }
    return { status: res.status, ok: res.ok, data: data || {} };
  }

  /* ---------- helpers ---------- */
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(cls, text, onClick, disabled) {
    const b = h("button", "btn " + cls, text);
    b.type = "button";
    if (disabled) b.disabled = true;
    b.addEventListener("click", onClick);
    return b;
  }
  const people = n => n + (n === 1 ? " person" : " people");
  function clock(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    let hr = d.getHours();
    const ap = hr >= 12 ? "PM" : "AM";
    hr = hr % 12 || 12;
    return hr + ":" + String(d.getMinutes()).padStart(2, "0") + " " + ap;
  }
  function slot24(s) {
    const p = /^(\d{1,2}):(\d{2})/.exec(s || "");
    if (!p) return "no entry time";
    let hr = +p[1];
    const ap = hr >= 12 ? "PM" : "AM";
    hr = hr % 12 || 12;
    return hr + ":" + p[2] + " " + ap;
  }
  function nightLabel(ymd) {
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
    if (!p) return ymd || "another night";
    const d = new Date(+p[1], +p[2] - 1, +p[3]);
    return DOW[d.getDay()] + " " + MON[d.getMonth()] + " " + d.getDate();
  }

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
  }

  /* Two-tap confirm: arm(id) marks a button as armed for a few seconds. */
  const armed = new Map();
  function isArmed(id) { const t = armed.get(id); return !!t && Date.now() - t < ARM_MS; }
  function arm(id) {
    armed.set(id, Date.now());
    renderAll(true);
    setTimeout(() => { if (!isArmed(id)) { armed.delete(id); renderAll(true); } }, ARM_MS + 50);
  }

  /* One request per row at a time. */
  const busy = new Set();

  /* ---------- state ---------- */
  let list = null;           // last good list response
  let skew = 0;              // server now - client now
  let results = null;        // last find results
  let findSeq = 0;
  let lastSig = "";
  let findNote = "";
  const rowMsg = new Map();  // code -> message shown under a find result

  function renderAll(force) {
    if (!list) return;
    const sig = JSON.stringify([list.night, list.waiting, list.called, list.totals, results, findNote,
      [...rowMsg], [...busy], [...armed].map(a => isArmed(a[0]) ? a[0] : 0), calling]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    renderTotals(); renderResults(); renderWaiting(); renderCalled(); tick();
  }

  function renderTotals() {
    const t = list.totals || {};
    els.tIn.textContent = t.checked_in || 0;
    els.tWait.textContent = t.waiting || 0;
    els.tHouse.textContent = t.arrived || 0;
    els.tSold.textContent = t.tickets_tonight || 0;
  }

  /* ---------- check-in results ---------- */
  function statusText(q) {
    return q === "waiting" ? "Already in line" : q === "called" ? "Already called" : q === "in" ? "Already in the house" : "";
  }
  function renderResults() {
    els.results.textContent = "";
    if (findNote) { els.findNote.textContent = findNote; els.findNote.hidden = false; } else { els.findNote.hidden = true; }
    if (!results) return;
    for (const r of results) {
      const li = h("li", "row");
      const info = h("div", "info");
      info.append(h("p", "name", r.name || r.code));
      const meta = h("p", "meta");
      meta.textContent = people(r.party) + " · entry " + slot24(r.slot) + (r.phone_last4 ? " · phone " + r.phone_last4 : "");
      info.append(meta);
      info.append(h("p", "meta code", r.code));
      if (r.other_night) info.append(h("p", "tag warn", "Ticket is for " + nightLabel(r.night)));
      const st = statusText(r.queue);
      if (st) info.append(h("p", "tag ok", st));
      const msg = rowMsg.get(r.code);
      if (msg) info.append(h("p", "tag warn", msg));
      li.append(info);

      if (!r.queue) {
        const id = "ci:" + r.code;
        const b = busy.has(id);
        if (r.other_night || isArmed("force:" + r.code)) {
          const a = isArmed("force:" + r.code);
          li.append(btn(a ? "danger" : "ghost", a ? "Check in anyway" : "Check in", () => {
            if (a) checkin(r, true); else arm("force:" + r.code);
          }, b));
        } else {
          li.append(btn("primary", "Check in", () => checkin(r, false), b));
        }
      }
      els.results.append(li);
    }
  }

  async function checkin(r, force) {
    const id = "ci:" + r.code;
    if (busy.has(id)) return;
    busy.add(id); armed.delete("force:" + r.code); rowMsg.delete(r.code); renderAll(true);
    try {
      const res = await api(force ? { op: "checkin", code: r.code, force: true } : { op: "checkin", code: r.code });
      if (res.ok) {
        r.queue = "waiting";
        toast(res.data.already ? r.name + " was already in line." : (r.name || r.code) + " checked in.");
      } else {
        const e = res.data.error;
        if (e === "wrong_night") {
          r.other_night = true; r.night = res.data.night || r.night;
          rowMsg.set(r.code, "Ticket is for " + nightLabel(r.night) + ". Tap again to check in anyway.");
          armed.set("force:" + r.code, Date.now());
          setTimeout(() => renderAll(true), ARM_MS + 50);
        } else if (e === "not_paid") {
          rowMsg.set(r.code, "Not paid (" + (res.data.status || "unknown") + "). Cannot check in.");
        } else if (e === "not_found") {
          rowMsg.set(r.code, "Ticket not found.");
        } else {
          rowMsg.set(r.code, "Could not check in. Try again.");
        }
      }
    } catch (e) {
      if (e instanceof AuthError) return;
      rowMsg.set(r.code, "No connection. Try again.");
    } finally {
      busy.delete(id);
    }
    renderAll(true);
    refresh();
  }

  /* ---------- waiting ---------- */
  function renderWaiting() {
    els.waiting.textContent = "";
    const w = list.waiting || [];
    els.waitingEmpty.hidden = w.length > 0;
    els.waitingCount.textContent = w.length ? "(" + w.length + (w.length === 1 ? " party)" : " parties)") : "";
    w.forEach((r, i) => {
      const li = h("li", "row");
      li.append(h("span", "pos", String(i + 1)));
      const info = h("div", "info");
      info.append(h("p", "name", r.name || r.code));
      info.append(h("p", "meta", people(r.party) + " · entry " + (r.slot || "no entry time")));
      if (r.pushed) info.append(h("p", "tag push", "Pushed to " + r.eff_slot));
      li.append(info);
      const id = "rm:" + r.code, a = isArmed(id);
      li.append(btn(a ? "danger" : "ghost small", a ? "Tap to remove" : "Remove", () => {
        if (a) act(id, { op: "remove", code: r.code }); else arm(id);
      }, busy.has(id)));
      els.waiting.append(li);
    });
  }

  /* ---------- called ---------- */
  function renderCalled() {
    els.called.textContent = "";
    const g = list.called || [];
    els.calledEmpty.hidden = g.length > 0;
    for (const grp of g) {
      const box = h("section", "group");
      box.dataset.called = grp.called_at || "";
      const head = h("div", "ghead");
      head.append(h("h3", null, "Group " + grp.group_no));
      head.append(h("span", "gpeople", people(grp.people)));
      box.append(head);
      const clk = h("p", "gclock");
      const since = h("span", "since"), left = h("span", "left");
      clk.append(since, left);
      box.append(clk);
      const ul = h("ul", "rows");
      for (const r of grp.parties) {
        const li = h("li", "row" + (r.late ? " late" : "") + (r.arrived_at ? " here" : ""));
        const info = h("div", "info");
        info.append(h("p", "name", r.name || r.code));
        info.append(h("p", "meta", people(r.party)));
        if (r.late) info.append(h("p", "tag bad", "Late"));
        else if (r.arrived_at) info.append(h("p", "tag ok", "Here"));
        li.append(info);
        const ia = "ar:" + r.code, ib = "bk:" + r.code;
        const wrap = h("div", "acts");
        if (r.late) wrap.append(btn("danger small", "Late - push back", () => act(ib, { op: "back", code: r.code }), busy.has(ib)));
        if (r.arrived_at) {
          wrap.append(btn("ghost small", "Here ✓ (undo)", () => act(ia, { op: "arrived", code: r.code, undo: true }), busy.has(ia)));
        } else {
          wrap.append(btn("primary small", "Here", () => act(ia, { op: "arrived", code: r.code }), busy.has(ia)));
        }
        li.append(wrap);
        ul.append(li);
      }
      box.append(ul);
      els.called.append(box);
    }
  }

  /* Live clocks: text only, no re-render. */
  function tick() {
    if (!list) return;
    const now = Date.now() + skew;
    const limit = (list.late_minutes || 10) * 60000;
    els.called.querySelectorAll(".group").forEach(box => {
      const t = Date.parse(box.dataset.called);
      if (isNaN(t)) return;
      const el = Math.max(0, now - t);
      const since = box.querySelector(".since"), left = box.querySelector(".left");
      since.textContent = "Called " + Math.floor(el / 60000) + " min ago";
      const rem = limit - el;
      const allHere = !box.querySelector(".row:not(.here)");
      if (allHere) { left.textContent = "All here"; left.className = "left ok"; }
      else if (rem > 0) {
        const s = Math.ceil(rem / 1000);
        left.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " left";
        left.className = "left" + (rem < 120000 ? " soon" : "");
      } else { left.textContent = "Time is up"; left.className = "left bad"; }
    });
  }

  /* ---------- actions ---------- */
  async function act(id, body) {
    if (busy.has(id)) return;
    busy.add(id); armed.delete(id); renderAll(true);
    try {
      const res = await api(body);
      if (!res.ok) toast("That did not go through. Try again.");
    } catch (e) {
      if (e instanceof AuthError) return;
      toast("No connection. Try again.");
    } finally {
      busy.delete(id);
    }
    renderAll(true);
    await refresh();
  }

  let calling = false;
  els.call.addEventListener("click", async () => {
    if (calling) return;
    calling = true; els.call.disabled = true; els.call.textContent = "Calling…";
    try {
      const res = await api({ op: "call" });
      if (!res.ok) { toast("Could not call a group. Try again."); }
      else if (res.data.group_no == null) { showCalled("The line is empty. Nobody to call."); }
      else {
        const n = res.data.group_no;
        await refresh();
        const g = ((list && list.called) || []).find(x => x.group_no === n);
        showCalled("Group " + n + " called - " + (g ? people(g.people) : "go"), true);
      }
    } catch (e) {
      if (!(e instanceof AuthError)) toast("No connection. Check that the group was called before trying again.");
    } finally {
      calling = false; els.call.disabled = false; els.call.textContent = "Call next group (15)";
      renderAll(true);
    }
    if (!els.app.hidden) refresh();
  });
  function showCalled(msg, good) {
    els.calledMsg.textContent = msg;
    els.calledMsg.className = "called-msg" + (good ? " good" : "");
    els.calledMsg.hidden = false;
  }

  /* ---------- find ---------- */
  async function doFind() {
    const q = els.q.value.trim();
    const seq = ++findSeq;
    if (q.length < 2) { results = null; findNote = ""; renderAll(true); return; }
    findNote = "Searching…"; renderAll(true);
    try {
      const res = await api({ op: "find", q });
      if (seq !== findSeq) return;
      if (!res.ok) { results = null; findNote = "Search failed. Try again."; }
      else {
        results = res.data.results || [];
        findNote = results.length ? "" : "No ticket found. Check the code, name, or last 4 digits of the phone.";
      }
    } catch (e) {
      if (e instanceof AuthError || seq !== findSeq) return;
      results = null; findNote = "No connection. Try again.";
    }
    renderAll(true);
  }
  let findTimer = 0;
  els.q.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(doFind, 350); });
  els.search.addEventListener("submit", e => { e.preventDefault(); clearTimeout(findTimer); doFind(); els.q.blur(); });

  /* ---------- refresh ---------- */
  let inflight = false, fails = 0;
  async function refresh() {
    if (!key || inflight) return;
    inflight = true;
    try {
      const res = await api({ op: "list" });
      if (!res.ok || !res.data.totals) throw new Error("bad");
      list = res.data;
      const sv = Date.parse(list.now);
      if (!isNaN(sv)) skew = sv - Date.now();
      fails = 0;
      els.nokey.hidden = true; els.app.hidden = false;
      els.sync.textContent = "Live · " + nightLabel(list.night);
      els.sync.className = "sync";
      renderAll(false);
    } catch (e) {
      if (e instanceof AuthError) { inflight = false; return; }
      fails++;
      els.sync.textContent = list ? "Offline - showing old list" : "Can't reach server";
      els.sync.className = "sync bad";
    }
    inflight = false;
  }

  /* ---------- go ---------- */
  if (!key) {
    showNoKey();
  } else {
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
    setInterval(tick, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
})();
