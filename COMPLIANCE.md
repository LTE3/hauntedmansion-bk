# Compliance

What this site collects, what the law asks of it, and where each rule is
enforced in code. Written so that the next person can check it in an hour
rather than take it on trust.

The site is a waitlist for a haunted attraction in Bushwick, Brooklyn, run by
Pulse Ticketing LLC. It asks for a name, an email address and, optionally, a
mobile number. It sets no cookies, loads nothing from third parties, and
sells nothing yet. That narrows the list of laws that reach it, and the ones
that do are below.

## The ten things a small site gets sued over

A widely shared checklist for "vibe-coded" sites lists ten exposures. Here is
each one against this site.

| # | Exposure | Here |
|---|----------|------|
| 1 | Marketing texts without written consent (TCPA) | **Enforced.** See "Texts" below. |
| 2 | Marketing email without unsubscribe and a postal address (CAN-SPAM) | **Open.** No marketing email is sent yet. Before the first one: unsubscribe link, physical address, opt-outs honoured within 10 days. The confirmation email path (Resend) must carry the same. |
| 3 | Inaccessible pages (ADA / WCAG 2.1 AA) | **Enforced.** Every page has a `<main>` landmark and an `<h1>`, colour contrast at or above 4.5:1, focus states, labelled fields, 44px targets. Checked with axe-core over all 21 pages, phone viewport, form open: 0 violations. |
| 4 | Tracking pixels and analytics without disclosure (CIPA, state privacy laws) | **Not present.** No analytics, no pixels, no third-party scripts. The privacy page says so and stays true because the Content Security Policy on each page allows no third-party origin (see `tools/csp.py`). |
| 5 | Third-party fonts leaking visitor IPs | **Fixed.** Typefaces are served from this origin (`v/fonts/`, written by `tools/selfhost_fonts.py`, licences alongside). No request to Google Fonts. |
| 6 | Collecting from children under 13 (COPPA) | **Stated.** The form says "13 and over." No age gate; the site does not target children and collects the minimum. |
| 7 | User-generated content without a DMCA agent | **Not applicable.** No uploads, no comments, no UGC. |
| 8 | Chatbot presented as a human | **Not applicable.** No chatbot. |
| 9 | Biometric data (BIPA) | **Not applicable.** None collected. |
| 10 | Fake urgency or scarcity (FTC, state UDAP) | **Removed.** No countdown that is not real, no "limited tickets" copy. The only number shown is the live registration count, and only when the database returns one. |

## Texts

Any number stored here may be texted marketing. That makes it "prior express
written consent" territory under the TCPA (47 U.S.C. § 227) and the FCC's
rules, including the 2024 revocation order in force since April 2025.

### Consent, at the point of collection

- Every phone field on the site is followed by a consent block, injected by
  `v/waitlist.js` so no page can ship a phone field without it. It appears
  once the visitor starts typing a number.
- The block is a checkbox ("Text me when the house opens.") and the disclosure:
  recurring automated marketing texts, from whom, about what, frequency varies,
  message and data rates may apply, not a condition of entry or purchase,
  STOP to stop, HELP for help, and that an unticked number is not kept.
- The number is sent to the database **only if the box is ticked**. Unticked,
  the request carries `phone: null`.
- The database stamps the row with the server's time and the disclosure
  version (`sms_consent_at`, `sms_consent_text = 'hm-sms-v1'`) in a BEFORE
  INSERT trigger. The client cannot set or backdate either. The full text of
  each disclosure version is in `hm_sms_consent_text`.
- Numbers are normalised to E.164 (`+1XXXXXXXXXX`) on the way in, so an
  opt-out matches whatever format the person originally typed.

Rows from before this record existed have no stamp and are **not** texted.
They stay that way until someone who knows how each number was collected sets
the stamp on purpose.

### Stopping

- Inbound texts hit the `hm-sms-inbound` edge function. It verifies Twilio's
  request signature before reading anything, logs every message to
  `hm_sms_inbound`, and on STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT /
  REVOKE / OPT OUT / REMOVE writes the number to `hm_sms_optout`. A trigger
  mirrors the opt-out onto every waitlist row with that number.
- START / UNSTOP / YES re-subscribes; HELP is answered with the program name,
  operator and a contact.
- Messages that match no keyword are still logged, because the FCC counts any
  reasonable wording as a revocation. Someone must read those.
- Twilio's own default opt-out handling remains on for the number as belt and
  braces; the function stays quiet when Twilio replies so nobody gets two
  confirmations (`HM_SMS_SELF_REPLY` switches that).

### Sending

Only the `hm-sms-send` edge function may text the list. It:

- requires a token (`HM_SMS_TOKEN`), and refuses everything when none is set;
- gets recipients from one SQL function, `hm_sms_recipients()`: dialable
  number, consent stamp present, no opt-out on the row, no opt-out in the
  table. Only the service role can call it;
- refuses to send outside **11:00 to 20:59 Eastern**. Federal quiet hours are
  8:00 to 21:00 in the recipient's local time; the window is narrowed so it
  holds for every mainland US zone;
- adds the brand name and "Reply STOP to opt out." if the operator's message
  lacks them;
- defaults to a dry run that returns the recipient count, the exact body and
  the segment count (the price) and sends nothing;
- logs every attempt to `hm_sms_log`, one row per number per blast, so a
  resumed blast never doubles a number;
- treats Twilio error 21610 (carrier has the number blocked) as an opt-out.

Setup, once, by the account owner:

```
supabase functions deploy hm-sms-inbound --no-verify-jwt
supabase functions deploy hm-sms-send
supabase secrets set HM_SMS_TOKEN=<long random string> HM_SMS_EXCLUDE=<staff numbers, comma-separated E.164>
```

Then in the Twilio console, on the toll-free number: Messaging, "A message
comes in", Webhook, POST,
`https://<project>.supabase.co/functions/v1/hm-sms-inbound`.

A blast, always dry first:

```
curl -X POST https://<project>.supabase.co/functions/v1/hm-sms-send \
  -H "apikey: <anon key>" -H "Authorization: Bearer <anon key>" \
  -H "x-hm-token: $HM_SMS_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Doors open Sept 25. Tickets go on sale Friday."}'
```

Read the count, the body and the segments. Then the same call with
`"dry_run": false`.

The rules themselves are pure functions in `supabase/functions/_shared/sms.ts`
and are tested with `node --test supabase/tests/sms.test.mjs`.

## Data

- Table `hm_waitlist`: name, email, phone (E.164 or null), user agent, created
  time, consent stamps. Row Level Security on. The anonymous key can insert
  four columns and call the count function, nothing else. A per-IP throttle
  trigger caps signups at 40 per 10 minutes.
- Tables `hm_sms_optout`, `hm_sms_inbound`, `hm_sms_log`,
  `hm_sms_consent_text`: RLS on, no anonymous or authenticated grants. Reached
  only by the edge functions with the service role.
- Retention: opt-outs are kept indefinitely, because forgetting one is the
  failure. Everything else is kept until the owner decides otherwise; the
  privacy page is where any change must be stated.
- Migrations are in `supabase/00N_*.sql` in order, each with its verification
  queries at the bottom.

## Privacy page

`privacy.html` describes exactly this: what is collected, why, that there are
no cookies or trackers, how texts work, how to stop them, and how to be
removed. When behaviour changes, the page changes in the same commit.

## Still open, for the owner

- Marketing email (item 2): nothing may go out until unsubscribe and postal
  address are in the template and the opt-out path exists.
- The contact address on the privacy page and in the HELP reply should be the
  monitored `admin@` mailbox once it is confirmed readable.
- Older text-sending functions in the Pulsetix project (`send-text-blast`,
  `send-text-to-list`) predate this record and do not consult it. They must
  not be used for this list.
- Rows with a phone but no consent stamp: decide, per source, whether the
  consent history supports a backfill. Until then they are not texted.
