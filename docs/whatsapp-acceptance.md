# WhatsApp Commerce — acceptance stories

**The rule from `docs/pos-acceptance.md` applies:** a slice is not done until
its user stories are in here, and a fixed gap must leave the "Known gaps"
table. Spec: `docs/whatsapp-commerce-plan.md`. Console setup:
`docs/whatsapp-phase0.md`.

> Each story names what a person does and what they must see. "Verified"
> records what has actually been run and where; everything else is a story,
> not evidence.

---

## Phase 0 — the platform's Meta app (2026-10-08)

**WA-0.1 — The webhook answers only Meta.** Open
`https://dev.storemink.com/api/webhooks/whatsapp` in a browser: `403
forbidden`. Append `?hub.mode=subscribe&hub.verify_token=<the dev token>&hub.challenge=hello`:
the page shows exactly `hello`. POST anything without a signature: `401`.
_Verified 2026-10-08 on dev (browser + curl + Cloud Logging)._

**WA-0.2 — A real message round-trips.** `npm run whatsapp:smoke` sends
`hello_world` from the Dev test number to a recipient handset; the handset
receives it. The recipient replies; within seconds Cloud Logging for
`storemink-web-dev` shows one `whatsapp webhook received` line carrying the
WABA id, the phone number id and `messages: {text: 1}` — and no message text,
no `wa_id`, no profile name. _Verified 2026-10-08 (send 19:20 IST, inbound
14:10:26 UTC)._

**WA-0.3 — Field subscription is not WABA subscription.** With every webhook
field subscribed and the handshake verified, a real message still does not
arrive until `POST /{WABA_ID}/subscribed_apps` is made with the app's token;
the dashboard's **Test** button delivers either way. _Verified 2026-10-08 —
the finding that produced plan §5 step 2's "not optional"._

---

## Phase 1, slice 1 — Connect (2026-10-08)

**WA-1.1 — The card and its gate.** Dashboard → Channels shows a **WhatsApp**
card under _Messaging_. On a Free store it carries a "Basic plan onwards"
badge and the modal explains the upgrade; on Basic/Pro with the platform
configured the modal offers **Connect with Meta**. With `WHATSAPP_CONFIG_ID`
empty on the environment the modal says WhatsApp isn't switched on yet and
the button stays disabled — never a popup the server cannot finish.

**WA-1.2 — Coexistence is asked before the popup.** The connect modal asks
_"Is this number already on the WhatsApp Business app?"_ and the button stays
disabled until one answer is chosen. "Yes" opens Meta's Coexistence
onboarding; "No" opens the ordinary one.

**WA-1.3 — Connect end to end.** On a Basic store, choose "No", press
Connect, complete Meta's popup (Facebook login → business → number → OTP).
The modal closes the popup and shows the number, the display name and its
review state, the daily sending limit, the quality rating and **Live**. In
the database the row holds the token and PIN encrypted, `app_subscribed_at`
and `registered_at` set; `GET /{WABA_ID}/subscribed_apps` with the merchant's
token lists the StoreMink app. _Not yet verified: needs the Embedded Signup
configuration (runbook §4.3)._

**WA-1.4 — Cancel is not an error.** Close Meta's popup at any step: no
toast, no row, the modal is where it was.

**WA-1.5 — The ids are proved, not trusted.** A crafted page that posts a
`WA_EMBEDDED_SIGNUP` message naming a WABA the login was not granted is
refused with "isn't one this login was granted"; nothing is subscribed or
stored. _Pinned by `lib/whatsapp/connect.test.ts`._

**WA-1.6 — One number, one store.** Connecting a number another store already
holds is refused with a message naming that, not a generic failure. _Pinned
by the unique constraint probe (`store_whatsapp_accounts_phone_number_id_key`)
and the connect test._

**WA-1.7 — Pause, refresh, disconnect.** Pause flips the card to _Paused_ and
`enabled=false`; Resume is refused on a store whose plan lapsed to Free.
**Refresh from Meta** re-reads tier/quality/name; a revoked token turns the
card to _Needs reconnecting_ with Meta's reason, and Resume is disabled until
reconnected. **Disconnect** asks first, tells Meta to stop posting
(best-effort) and removes the row; the merchant's Meta account is untouched.

**WA-1.8 — Webhook deliveries become rows.** After connecting, Meta's
deliveries for that number land in `whatsapp_inbound_events` with
`store_id` set; a redelivered status or message is a no-op on the UNIQUE
`(phone_number_id, field, event_id)`. A delivery for an unknown number is
stored with a null store and a warning, never dropped. Template status,
number quality/name and account events update the account and template rows
in the background; `messages` rows stay unprocessed until slice 2/3. _Pinned
by `inbound.test.ts` and the local Postgres probe (dedupe, cascade, grants)._

---

## Known gaps

| Gap                                                                                                                               | Since      | Status                           |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------- |
| The connect flow has not run against a live Embedded Signup popup — the Dev app's configuration (runbook §4.3) does not exist yet | 2026-10-08 | Waiting on the console step      |
| An unreachable database reads as "not connected" on the Channels card (the SMS card's documented gap, shared)                     | 2026-10-08 | Open                             |
| `messages` events are recorded but not processed — no inbox, no delivery statuses yet                                             | 2026-10-08 | Slices 2 and 3                   |
| No Help Centre guide yet — nothing a merchant can do changes until the connect button works on a live configuration               | 2026-10-08 | With slice 1's live verification |
