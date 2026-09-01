/* The real waitlist, for the candidate pages that were built without one.

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
        name: name, email: email, phone: phone || null,
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
