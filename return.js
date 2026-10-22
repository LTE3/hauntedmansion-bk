/* Returning guests (owner, 2026-10-21). The link carries ?i=<invite token>.
   hm-create-checkout answers how many $20 tickets that token has left, and
   refuses anything past that - this page only offers what it will accept. */
(function(){
  const SUPABASE_URL = "https://tqeunmqnaoyrerkbhokk.supabase.co";
  const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxZXVubXFuYW95cmVya2Job2trIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4OTQ1MzQsImV4cCI6MjA4OTQ3MDUzNH0.hkkuc7_YE2yf0w0NQENpahAxqxxqBfjq8n5QhtTIkw8";
  const HEADERS = { apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON, "Content-Type": "application/json" };
  const PRODUCTS = ["ret_one", "ret_two", "ret_three", "ret_four", "ret_five", "ret_six"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const $ = id => document.getElementById(id);
  const status = $("status"), form = $("buy"), nightsEl = $("nights"), timesEl = $("times");
  const timesSet = $("times-set"), qtySet = $("qty-set"), qtyEl = $("qty"), leftEl = $("left");
  const minus = $("minus"), plus = $("plus"), cta = $("cta"), errorEl = $("error");

  const token = (new URLSearchParams(location.search).get("i") || "").toLowerCase();
  let left = 0, qty = 1, night = null, time = null, sending = false;
  const byNight = {};

  const say = t => { status.textContent = t; };
  const fail = t => { errorEl.textContent = t; errorEl.hidden = false; };
  const post = (body, path) => fetch(SUPABASE_URL + path, { method: "POST", headers: HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });

  /* Night and clock in New York, so tonight's past entry times are not offered.
     Entry times after midnight (00:00) belong to the night before. */
  const nyParts = () => {
    const p = {};
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
    return { date: p.year + "-" + p.month + "-" + p.day, mins: +p.hour * 60 + +p.minute };
  };
  const slotMins = s => { const h = +s.slice(0, 2); return (h < 4 ? h + 24 : h) * 60 + +s.slice(3, 5); };
  const clock = s => { const h = +s.slice(0, 2), m = s.slice(3, 5); return (h % 12 || 12) + ":" + m + (h >= 12 ? " PM" : " AM"); };
  const nightName = d => { const x = new Date(d + "T12:00:00"); return DOW[x.getDay()] + " " + MON[x.getMonth()] + " " + x.getDate(); };

  function chip(label, onPick, disabled){
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = label;
    b.setAttribute("aria-pressed", "false");
    b.disabled = !!disabled;
    b.addEventListener("click", () => {
      b.parentElement.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c === b)));
      onPick();
    });
    return b;
  }

  function sync(){
    qtyEl.textContent = qty;
    minus.disabled = qty <= 1;
    plus.disabled = qty >= left;
    leftEl.textContent = "$" + qty * 20 + " total. Your link covers up to " + left + " ticket" + (left === 1 ? "" : "s") + ".";
    cta.disabled = sending || !night || !time;
    cta.textContent = night && time ? "Continue to payment · $" + qty * 20 : "Continue to payment";
  }

  function showTimes(d){
    night = d; time = null;
    timesEl.textContent = "";
    byNight[d].forEach(s => timesEl.appendChild(chip(clock(s.slot) + (s.adults ? " · 18+" : ""), () => { time = s.slot; qtySet.hidden = false; sync(); }, !s.open)));
    timesSet.hidden = false;
    errorEl.hidden = true;
    sync();
  }

  minus.addEventListener("click", () => { if(qty > 1){ qty--; sync(); } });
  plus.addEventListener("click", () => { if(qty < left){ qty++; sync(); } });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    if(sending || !night || !time) return;
    sending = true; errorEl.hidden = true; sync();
    cta.textContent = "Reaching the box office…";
    try{
      const r = await post({ event_date: night, slot: time, product: PRODUCTS[qty - 1], invite: token }, "/functions/v1/hm-create-checkout");
      let data = null;
      try{ data = await r.json(); }catch(_){}
      if(r.ok && data && data.url){ location.href = data.url; return; }
      if(r.status === 409 && data && data.error === "sold_out") fail("That entry time just filled up. Pick another time or night.");
      else if(r.status === 409 && data && data.error === "invite_used"){ left = Math.max(0, data.left || 0); qty = Math.min(qty, Math.max(1, left)); fail(left ? "Your link has " + left + " ticket" + (left === 1 ? "" : "s") + " left." : "This link's tickets have all been used."); }
      else if(r.status === 409) fail("That night isn't on sale. Pick another night.");
      else fail("Could not reach the box office. Try again.");
    }catch(_){
      fail("Could not reach the box office. Try again.");
    }
    sending = false; sync();
  });

  if(!/^[a-f0-9]{16}$/.test(token)){ say("This link isn't complete. Open it again from your email, or reply to that email and we'll sort it out."); return; }

  Promise.all([
    post({ check: true, invite: token }, "/functions/v1/hm-create-checkout").then(r => r.json().then(d => ({ ok: r.ok, d }))),
    post({}, "/rest/v1/rpc/hm_open_slots").then(r => r.ok ? r.json() : [])
  ]).then(([inv, rows]) => {
    if(!inv.ok){ say("We couldn't find this invite. Reply to the email it came in and we'll sort it out."); return; }
    left = inv.d.left;
    if(inv.d.name) $("hello").textContent = "Hi " + inv.d.name + ", thank you for giving us another chance.";
    if(left < 1){ say("Your returning-guest tickets have all been booked. See you there!"); return; }
    const now = nyParts();
    (Array.isArray(rows) ? rows : []).forEach(r => {
      if(r.event_date < now.date) return;
      const slot = String(r.slot).slice(0, 5);
      const past = r.event_date === now.date && slotMins(slot) <= now.mins + 15;
      if(past) return;
      (byNight[r.event_date] = byNight[r.event_date] || []).push({ slot, open: !!r.open, adults: !!r.adults_only });
    });
    const nights = Object.keys(byNight).filter(d => byNight[d].some(s => s.open)).sort();
    if(!nights.length){ say("No nights are open right now. Reply to your email and we'll let you know when more are added."); return; }
    nights.forEach(d => byNight[d].sort((a, b) => slotMins(a.slot) - slotMins(b.slot)));
    nights.forEach(d => nightsEl.appendChild(chip(nightName(d), () => showTimes(d))));
    say("");
    form.hidden = false;
    sync();
  }).catch(() => say("Could not reach the box office. Refresh to try again."));
})();
