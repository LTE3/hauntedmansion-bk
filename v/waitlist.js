/* The real waitlist, for the candidate pages that were built without one.

   Every page that loads this gets the same text-consent block under its
   phone field and the same rule: no tick, no number stored.

   Living Door and The List were drawn as pictures of a signup: their forms
   hid themselves and showed a thank-you, and nobody's name went anywhere.
   This is the same flow the live page and the keyhole already run - same
   table, same duplicate handling, same honeypot - lifted out so the two
   candidates behave like the real thing while they are being judged. A
   design you cannot actually sign up to is not a design you can compare.

   Each page wires itself up with data attributes on the script tag, because
   the three candidates disagree about what to call everything:

     <script src="waitlist.js"
             data-form="#form"          the <form> to take over
             data-formbox="#formwrap"   what to hide on success
             data-done="#success"       what to show instead
             data-submit=".submit"      the button, for its disabled state
             data-submit-label="Enter the waitlist"
             data-count="#count"        optional, the number
             data-counter="#counter"    optional, its container
             data-counter-on="on"></script>

   The anon key is the publishable one. It is already in the live page for the
   same reason: row-level security is what protects the table, not secrecy of
   this string. The management token is not here and never goes near a browser.
*/
(function () {
  var s = document.currentScript, d = s.dataset;
  var form = document.querySelector(d.form || "form");
  if (!form) return;

  var URL_ = "https://tqeunmqnaoyrerkbhokk.supabase.co";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRxZXVubXFuYW95cmVya2Job2trIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4OTQ1MzQsImV4cCI6MjA4OTQ3MDUzNH0.hkkuc7_YE2yf0w0NQENpahAxqxxqBfjq8n5QhtTIkw8";
  var COUNTER_MIN = 25;
  var headers = {
    "apikey": ANON,
    "Authorization": "Bearer " + ANON,
    "Content-Type": "application/json"
  };

  var box = d.formbox ? document.querySelector(d.formbox) : null;
  var done = d.done ? document.querySelector(d.done) : null;
  var go = (d.submit && form.querySelector(d.submit)) || form.querySelector("button");
  var goLabel = d.submitLabel || (go && go.textContent.trim()) || "Send";
  var sending = false;

  /* A bot fills in every field it can see, including the ones a person cannot.
     Built here rather than in the markup so the two candidates cannot ship
     without it. */
  var pot = document.createElement("input");
  /* Not "company": a password manager fills that one despite
     autocomplete="off", and a filled pot silently discards the row. The
     name has to match no autofill category at all. */
  pot.name = "hm_ref";
  pot.tabIndex = -1;
  pot.autocomplete = "off";
  pot.setAttribute("aria-hidden", "true");
  pot.style.cssText =
    "position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
  form.appendChild(pot);

  var err = document.createElement("p");
  err.setAttribute("role", "alert");
  err.style.cssText = "min-height:1.2em;margin:8px 0 0;color:#ff6a5e;font-size:14px";
  form.appendChild(err);

  /* Text consent, shown only once a number is typed, and never pre-ticked.
     The same words as the live page: the disclosure has to sit at the point
     of collection, and a marketing text needs prior express written consent
     (TCPA). A number with the box left unticked is never sent anywhere - see
     the submit handler. Built here rather than in the markup so no page can
     ship a phone field without it. Styles are set on the elements because
     the pages' policies hash their stylesheets and allow no style attribute
     in markup; setting .style from script is permitted and is not the same
     thing. */
  var phoneField = field("phone"), smsEl = null;
  if (phoneField) {
    var consent = document.createElement("div");
    consent.className = "consent";
    consent.hidden = true;
    consent.style.cssText = "margin:-4px 0 14px";
    var tick = document.createElement("label");
    tick.style.cssText = "display:flex;gap:11px;align-items:center;margin:0;min-height:44px;cursor:pointer;" +
      "font-size:15px;font-weight:600;line-height:1.3;letter-spacing:0;text-transform:none;color:inherit";
    smsEl = document.createElement("input");
    smsEl.type = "checkbox";
    smsEl.name = "sms";
    smsEl.style.cssText = "width:22px;height:22px;flex:none;margin:0;accent-color:#c22119";
    var tickText = document.createElement("span");
    tickText.textContent = "Text me when the house opens.";
    tickText.style.cssText = "display:inline;font:inherit;letter-spacing:0;text-transform:none;color:inherit;opacity:1";
    tick.appendChild(smsEl);
    tick.appendChild(tickText);
    var fine = document.createElement("p");
    fine.style.cssText = "margin:4px 0 0;font-size:13px;line-height:1.45;color:inherit";
    fine.textContent = "Recurring automated marketing texts from Pulse Ticketing LLC at the number above \u2014 " +
      "opening night and ticket on-sales. Frequency varies. Message and data rates may apply. " +
      "Not a condition of entry or of any purchase. Reply STOP to stop, HELP for help. " +
      "Leave this unticked and your number is not kept.";
    consent.appendChild(tick);
    consent.appendChild(fine);
    var after = phoneField.closest("label") || phoneField;
    after.parentNode.insertBefore(consent, after.nextSibling);
    phoneField.addEventListener("input", function () {
      if (consent.hidden && phoneField.value.trim()) consent.hidden = false;
    });
  }

  function field(name) { return form.elements.namedItem(name); }

  function fail(el, message) {
    err.textContent = message;
    if (!el) return;
    el.setAttribute("aria-invalid", "true");
    el.focus();
    el.addEventListener("input", function () {
      el.removeAttribute("aria-invalid");
      err.textContent = "";
    }, { once: true });
  }

  /* Only ever shown when it is real, and only once it is a number worth
     showing. An empty list that announces itself is worse than silence. */
  function paintCount() {
    var out = d.count && document.querySelector(d.count);
    var wrap = d.counter && document.querySelector(d.counter);
    if (!out) return;
    fetch(URL_ + "/rest/v1/rpc/hm_waitlist_count", {
      method: "POST", headers: headers, body: "{}"
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (n) {
        if (typeof n !== "number" || n < COUNTER_MIN) return;
        out.textContent = n.toLocaleString();
        if (wrap) wrap.classList.add(d.counterOn || "on");
      })
      .catch(function () { });
  }
  paintCount();

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (sending) return;
    err.textContent = "";

    var nameEl = field("name"), emailEl = field("email"), phoneEl = field("phone");
    var name = (nameEl && nameEl.value || "").trim();
    var email = (emailEl && emailEl.value || "").trim();
    var phone = (phoneEl && phoneEl.value || "").trim();

    /* A filled honeypot gets the thank-you and no row. Telling a bot it
       failed only teaches it what to change. */
    if (pot.value) { finish(); return; }

    [nameEl, emailEl].forEach(function (el) { el && el.removeAttribute("aria-invalid"); });
    if (name.length < 1) { fail(nameEl, "The house wants a name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      fail(emailEl, "That address will not reach you.");
      return;
    }

    sending = true;
    if (go) { go.disabled = true; go.textContent = "Opening"; }

    fetch(URL_ + "/rest/v1/hm_waitlist", {
      method: "POST",
      headers: Object.assign({}, headers, { Prefer: "return=minimal" }),
      body: JSON.stringify({
        /* Kept only with the tick. Unticked, the number stays in the page. */
        name: name, email: email, phone: (smsEl && smsEl.checked && phone) || null,
        user_agent: navigator.userAgent
      })
    }).then(function (r) {
      /* 409 is the same address twice. That is a person who already signed
         up, not an error to show them. */
      if (!r.ok && r.status !== 409) throw new Error(String(r.status));
      sending = false;
      finish();
      paintCount();
    }).catch(function () {
      sending = false;
      if (go) { go.disabled = false; go.textContent = goLabel; }
      err.textContent = "The door stuck. Try again.";
    });
  });

  function finish() {
    if (box) box.style.display = "none";
    if (done) {
      done.style.display = "block";
      if (done.focus) done.focus();
    }
  }
})();
