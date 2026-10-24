/* The Graveyard line, on the ticket page. Guests learn here when their group is
   called; staff with the saved key can check a scanned ticket into the line.
   Waits for the ticket script's "hm:ticket" event (a paid ticket has rendered),
   so no code is ever polled for an unpaid or unknown ticket. All text goes in
   with textContent. */
(() => {
  const API = "https://tqeunmqnaoyrerkbhokk.supabase.co/functions/v1/hm-queue";
  const CODE = /^HM-[0-9A-F]{8}$/;
  const POLL_MS = 15000;
  const $ = id => document.getElementById(id);
  const baseTitle = document.title;

  let code = null, timer = null, prev = null, last = null, staffKey = null, force = false, busy = false;

  try{ staffKey = localStorage.getItem("hm_queue_key") || null; }catch(e){}

  const set = (id, text) => {
    const el = $(id);
    if(!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  };

  /* ---- guest ---- */
  const groups = n => n === 1 ? "1 group" : n + " groups";

  /* A phone only buzzes or beeps for a page the guest has tapped, and a
     locked screen stops the polling. One tap unlocks sound, buzz and a
     screen wake lock. iPhones never vibrate from a web page; they get
     the sound. */
  let audio = null, wake = null;
  const holdAwake = () => {
    try{ if(navigator.wakeLock && !wake) navigator.wakeLock.request("screen").then(w => { wake = w; w.addEventListener("release", () => { wake = null; }); }).catch(() => {}); }catch(e){}
  };
  const beep = () => {
    if(!audio) return;
    try{
      const t = audio.currentTime;
      [0, 0.45, 0.9].forEach(dt => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.0001, t + dt);
        g.gain.exponentialRampToValueAtTime(0.4, t + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.3);
        o.start(t + dt); o.stop(t + dt + 0.32);
      });
    }catch(e){}
  };
  const armAlerts = () => {
    const btn = $("hmq-alert");
    try{
      const AC = window.AudioContext || window.webkitAudioContext;
      if(AC && !audio){ audio = new AC(); audio.resume(); }
    }catch(e){}
    try{ if(navigator.vibrate) navigator.vibrate(60); }catch(e){}
    holdAwake();
    beep();
    if(btn){ btn.dataset.on = ""; btn.textContent = "Beep on while this page is open"; }
  };

  const showGuest = d => {
    const card = $("hmq-card"), quiet = $("hmq-quiet");
    if(!card || !quiet) return;
    const s = d && d.state;
    const alertBtn = $("hmq-alert");
    if(alertBtn) alertBtn.hidden = s !== "waiting";
    if(s === "waiting" || s === "called" || s === "in"){
      card.hidden = false; quiet.hidden = true; card.dataset.s = s;
    }else{
      card.hidden = true; quiet.hidden = false; delete card.dataset.s;
      document.title = baseTitle;
      return;
    }
    const calling = d.now_calling ? "Now calling group " + d.now_calling : "";
    if(s === "waiting"){
      const n = Number(d.ahead_groups) || 0;
      set("hmq-kick", "The Graveyard line");
      set("hmq-head", "You’re in line");
      set("hmq-big", "");
      set("hmq-sub", n === 0 ? "You’re in the next group or two" : "About " + groups(n) + " ahead of you");
      set("hmq-sub2", calling);
      set("hmq-note", d.pushed
        ? "You checked in after your entry time, so you’re now in the " + d.eff_slot + " session. Go enjoy The Graveyard and check back here anytime. It updates the second you open it."
        : "Go enjoy The Graveyard. Check back here anytime. It updates the second you open it.");
    }else if(s === "called"){
      set("hmq-kick", "The Graveyard line");
      set("hmq-head", "Your group is up");
      set("hmq-big", "Group " + d.group_no);
      set("hmq-sub", "Head to the house now.");
      set("hmq-sub2", "");
      set("hmq-note", "You have 10 minutes. After that your group moves on without you.");
    }else{
      set("hmq-kick", "");
      set("hmq-head", "You’re in");
      set("hmq-big", "");
      set("hmq-sub", "Enjoy the house.");
      set("hmq-sub2", "");
      set("hmq-note", "");
    }
    if(s === "called"){
      document.title = "Your group is up!";
      if(prev !== "called"){
        try{ if(navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]); }catch(e){}
        beep();
      }
    }else{
      document.title = baseTitle;
    }
  };

  const guestText = d => {
    if(!d) return "";
    if(d.state === "waiting") return "In line. About " + groups(Number(d.ahead_groups) || 0) + " ahead. " + d.eff_slot + " session.";
    if(d.state === "called") return "Called. Group " + d.group_no + ".";
    if(d.state === "in") return "Already in the house. Group " + d.group_no + ".";
    return "Not in the line yet.";
  };

  const poll = async () => {
    if(!code) return;
    try{
      const res = await fetch(API + "?t=" + encodeURIComponent(code), {cache: "no-store"});
      if(!res.ok) return;
      const d = await res.json();
      showGuest(d);
      last = d;
      prev = d.state;
      if(staffKey) set("hmq-s-guest", guestText(d));
    }catch(e){ /* keep what is on screen; the next tick tries again */ }
  };

  const restart = () => {
    clearInterval(timer); timer = null;
    if(!document.hidden){ poll(); timer = setInterval(poll, POLL_MS); }
  };

  /* ---- staff ---- */
  const night = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if(!m) return iso || "another night";
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric", timeZone: "UTC"});
  };

  const checkin = async () => {
    const btn = $("hmq-s-go");
    if(busy || !staffKey || !code) return;
    busy = true; btn.disabled = true;
    set("hmq-s-result", "Checking in…");
    try{
      const res = await fetch(API, {
        method: "POST",
        headers: {"Content-Type": "application/json", "x-hm-queue": staffKey},
        body: JSON.stringify(force ? {op: "checkin", code, force: true} : {op: "checkin", code})
      });
      let r = {};
      try{ r = await res.json(); }catch(e){}
      if(res.ok && r.ok){
        force = false;
        btn.textContent = "Check in to the line";
        set("hmq-s-result", r.already ? "Already in the line." : "Checked in. They are in the line.");
        await poll();
      }else if(res.status === 409 && r.error === "wrong_night"){
        force = true;
        btn.textContent = "Check in anyway";
        set("hmq-s-result", "This ticket is for " + night(r.night) + ", not tonight.");
      }else if(res.status === 409 && r.error === "not_paid"){
        set("hmq-s-result", "Not checked in. This ticket is not paid" + (r.status ? " (" + r.status + ")" : "") + ".");
      }else if(res.status === 409 && r.error === "not_found"){
        set("hmq-s-result", "Not checked in. Ticket not found.");
      }else if(res.status === 401){
        set("hmq-s-result", "Staff key not accepted. Open the staff link again.");
      }else{
        set("hmq-s-result", "Could not check in. Try again.");
      }
    }catch(e){
      set("hmq-s-result", "No connection. Try again.");
    }
    busy = false; btn.disabled = false;
  };

  const showStaff = d => {
    const panel = $("hmq-staff");
    if(!panel || !staffKey) return;
    set("hmq-s-who", (d.name ? d.name + " · " : "") + (Number(d.tickets) || 0) + (Number(d.tickets) === 1 ? " guest" : " guests"));
    panel.hidden = false;
    $("hmq-s-go").addEventListener("click", checkin);
  };

  /* ---- start ---- */
  document.addEventListener("hm:ticket", e => {
    const d = e.detail || {};
    if(!CODE.test(d.ticket_code || "") || code) return;
    code = d.ticket_code;
    showStaff(d);
    const alertBtn = $("hmq-alert");
    if(alertBtn) alertBtn.addEventListener("click", armAlerts);
    restart();
    document.addEventListener("visibilitychange", () => { restart(); if(audio && !document.hidden) holdAwake(); });
  });
})();
