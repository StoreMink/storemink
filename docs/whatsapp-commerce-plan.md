# WhatsApp Commerce — the design (v2)

**Status:** ◐ **Phase 1 code complete on dev; live verification pending**
(2026-10-13). Phase 0's dev gate passed 2026-10-08; slices 1–3 (connect,
notify, inbox) are built; production waits on App Review. Decisions: §19.
Progress per phase is in §16 and `docs/whatsapp-acceptance.md`.
v1 (2026-10-04) was a merchant-facing brief; this version keeps its product
shape and turns it into a buildable spec. The review that produced it is in
§18.
**Slots into:** `docs/roadmap.md` as a new track beside Step 5 (which currently
says "WhatsApp remains out of scope, owner 2026-08-15" — retire that line in the
commit that adopts this doc).
**Depends on:** `CODEBASE.md` §12 (checkout), §18 (BYO Razorpay), §22 (POS),
§23 (pickup), §24 (notifications), §27 (cancellation), §36 (till customers and
E.164 phones), §37 (SMS — the closest precedent), §38 (offers), §20a (Mink).

WhatsApp Commerce lets a seller sell, send order updates and talk to customers
on WhatsApp, under **Dashboard → Channels → WhatsApp**, with no third-party app.
Shopify has nothing built in — merchants glue Interakt/Wati/Gallabox onto a Meta
catalogue sync — so one integrated channel is a real advantage. The target is
**parity with what those apps sell** (§4), not a notifications-only channel.

This doc answers: **what exists to reuse** (§1), **what Meta requires and why it
shapes the design** (§2–§3), **the parity target** (§4), **the merchant and
customer journeys** (§5–§6), **the decisions that are expensive to change
later** (§7–§14), **the schema** (§15), **the build order** (§16), **what is
deliberately not built** (§17) and **the settled decisions** (§19).

> **★ marks a non-obvious invariant** — something that looks right by accident
> and breaks silently. Those are the lines worth re-reading during review.

---

## 1. What exists today (do not rebuild it)

| Piece                                                                                                 | State                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/notifications/channels.ts`                                                                       | ✅ `whatsapp` is already a declared channel key, `available: false` ("WhatsApp Business isn't connected yet"); saves are refused server-side while locked       |
| `lib/notifications/events.ts` + `record.ts` fan-out                                                   | ✅ 60 events, two audiences (team/customer), per-event per-audience channel switches; SMS branch at `record.ts` ~L634–723 is the shape to copy                  |
| `lib/sms/` (§37)                                                                                      | ✅ BYO provider per store, encrypted creds, template mirror per event, queue + worker on the send-emails heartbeat, choke point + coverage test, log + Failures |
| `store_sms_providers`, `store_sms_templates`, `sms_logs`, `notification_sms_queue`                    | ✅ the four-table shape every channel here needs                                                                                                                |
| `lib/payments/crypto.ts` (`PAYMENT_CRED_KEY`)                                                         | ✅ AES-256-GCM for provider secrets; the Meta business token goes under it                                                                                      |
| `app/api/webhooks/payments/[storeId]`, `/webhooks/logistics`, `/webhooks/resend`                      | ✅ three verified-signature webhook routes; the Razorpay one is the HMAC-over-raw-body pattern                                                                  |
| `app/dashboard/channels/`                                                                             | ✅ Razorpay, Shiprocket, Twilio cards; `getXChannelState` → `ChannelsClient` props                                                                              |
| `users.phone` in E.164, `storedPhoneVariants`, `pos_` claimable rows (§36)                            | ✅ a WhatsApp `wa_id` is the same digits without `+`; unknown senders get a phone-only row that signup later adopts                                             |
| `newsletter_subscribers` (consent text + timestamp + source)                                          | ✅ the consent-record shape for opt-ins                                                                                                                         |
| `placeOrder` (§12) and `placePosSale` (§22)                                                           | ✅ the two trust boundaries; pricing, offers, stock, tax, shipping and gift logic all live behind them                                                          |
| `lib/orders/approve-cancellation.ts` (§27)                                                            | ✅ one implementation of cancelling, shared by three callers — COD "cancel" becomes the fourth                                                                  |
| Coupon email campaigns + Mink Phase 5E (`email_campaigns`, audience snapshot, cost preview, schedule) | ✅ the broadcast shape                                                                                                                                          |
| Public Help assistant (`app/actions/help-assistant-actions.ts`)                                       | ✅ the only customer-facing, stateless, citation-validated model call — the precedent for customer-facing Mink                                                  |
| `orders.sales_channel` CHECK `('online','pos')`, Orders workspace books (§22)                         | ✅ a third channel is a widened CHECK plus a third book                                                                                                         |
| `user_groups`, `lib/offers/`, PIN shipping quote, store policies (§25)                                | ✅ what customer-facing Mink answers from                                                                                                                       |
| `BrowserQRCodeSvgWriter` (collection codes)                                                           | ✅ draws the counter QR                                                                                                                                         |
| `RETENTION_POLICIES` (§32)                                                                            | ✅ where chat retention goes                                                                                                                                    |
| `lib/plans.ts` `onlinePayments` (Basic+), `emailCampaigns` (Pro)                                      | ✅ the two gates WhatsApp mirrors                                                                                                                               |

Not present, and needed: a server-side cart (abandoned-cart reminders cannot
remind anyone about a cart StoreMink does not store — `CartProvider` is browser
state), a Razorpay payment-link client (only orders + checkout.js exist), and
any conversation/inbox model (enquiries are a form, not a thread).

---

## 2. What Meta requires, and why it shapes the design

These are Meta's rules. Each one either changes a phase boundary or a table.

| Rule                                                                                                                                                                                                                                                                                                       | Consequence here                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **StoreMink must be a Tech Provider.** Business Verification, App Review (Advanced Access for `whatsapp_business_messaging` + `whatsapp_business_management`, two demo videos) and Access Verification. Until all three pass, Embedded Signup onboards **10 new merchants per rolling 7 days**; 200 after. | Phase 0 (§16) is paperwork and waiting. Start it before writing code.                                                                            |
| **Business-initiated messages must use an approved template**, per WABA, per language. Templates are submitted via API, approved in minutes to days, can be rejected, and can be **paused** for low quality.                                                                                               | The existence of an APPROVED template is the real switch for an event (§37's DLT rule). Template status lives in a table and is read at fan-out. |
| **24-hour customer-service window.** After an inbound message, free-form replies are free for 24 h; utility templates inside the window are free too. Outside it: templates only.                                                                                                                          | `last_inbound_at` per contact; the inbox shows the countdown and offers "re-open with a template" when it has lapsed.                            |
| **Messaging tiers.** Unverified: 250 unique customers / 24 h for business-initiated messages; verified: 1,000, scaling to unlimited on quality.                                                                                                                                                            | Order updates fit day one; a broadcast does not. The connect card shows tier + verification status, and broadcasts refuse to exceed the tier.    |
| **Per-user marketing cap.** Meta drops marketing templates to users who have received too many (error 131049), independent of us.                                                                                                                                                                          | Campaign reports show "not delivered: Meta user limit" as its own outcome, never as our failure.                                                 |
| **A number on the WhatsApp Business app cannot be registered on the API** unless **Coexistence** is used (app + API on one number; 1:1 chats sync both ways as echo messages, ~20 msg/s cap, no groups).                                                                                                   | Decision §7. Most Indian shop numbers ARE on the app, so this decides onboarding friction.                                                       |
| **Opt-in is required** for business-initiated messages; marketing opt-out (STOP) is the business's job.                                                                                                                                                                                                    | Two separate consents per contact (updates / marketing), recorded with text and timestamp; STOP enforced at send.                                |
| **Meta bills the merchant directly** (payment method in WhatsApp Manager); INR billing from Jan 2026, all WABAs must be INR by 31 Dec 2026 or messages stop.                                                                                                                                               | StoreMink never touches message money. Spend is shown from `pricing_analytics`, never computed from a hardcoded rate card.                       |
| **Pricing changes only on quarter boundaries** with a month's notice; India marketing rose 1 Jan 2026; India is NOT in the 1 Oct 2026 changes.                                                                                                                                                             | The rate card is an operator-edited platform table (the `mink_credit_packs` precedent), used only for the broadcast cost PREVIEW.                |
| **Payments in India**: `order_details` + a payment configuration; Meta now steers Razorpay/PayU/Cashfree users to Enhanced Payment Links / dynamic VPA.                                                                                                                                                    | Payment link first (Phase 3), in-chat pay last (Phase 4), each verified against a live account before it is relied on.                           |
| **Catalogue** is a Commerce Manager product catalogue under the merchant's business, connected to the WABA, subject to Meta commerce policy.                                                                                                                                                               | Variants are flat items (`retailer_id` = variant SKU); rejections surface in the dashboard, not silently.                                        |

---

## 3. One sentence model

**A WhatsApp account is a per-store BYO channel (like Razorpay and Twilio);
notifications fan out to it through the existing spine; inbound messages land in
an inbox; a WhatsApp order is an ordinary order with `sales_channel =
'whatsapp'` priced by the existing checkout core; customer-facing Mink is a new,
bounded, answer-only actor.**

---

## 4. The parity target

What Interakt / Wati / Zoko / Gallabox sell, grouped by the phase that builds it.
A row marked **—** is a deliberate non-goal (§17).

| Area         | Capability                                                                                                                                                              | Phase |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Connect      | Embedded Signup, Coexistence choice, display name + profile (address, description, hours, website), 2FA PIN                                                             | 1     |
| Connect      | Number health: tier, quality rating, template-pause state, token health, re-auth                                                                                        | 1     |
| Connect      | Spend from Meta `pricing_analytics`; INR-migration warning                                                                                                              | 1     |
| Notify       | Customer utility updates: placed, confirmed, shipped (tracking), delivered, pickup ready (code), collected, cancelled, refund, return approved/rejected, exchange ready | 1     |
| Notify       | Team alerts on WhatsApp (new order, low stock, return request) — the team audience the spine already has                                                                | 1     |
| Notify       | Delivery status (sent / delivered / read / failed) per message, in the log                                                                                              | 1     |
| Notify       | Opt-in at checkout + account; STOP for marketing                                                                                                                        | 1     |
| Inbox        | Basic: conversations, reply, needs-reply badge, customer panel (orders, credit, address)                                                                                | 1     |
| Inbox        | Full: assignment, labels, notes, canned replies, hours/away, media in/out, quoted replies, reactions, location, search, mobile                                          | 2     |
| Inbox        | 24-hour window countdown; re-open with a template                                                                                                                       | 2     |
| Automation   | Welcome / away / menu buttons; COD confirm ✅/❌; "where is my order" lookup                                                                                            | 2     |
| Templates    | Template manager: list, status, submit custom (quick-reply, URL, call, copy-code, media header, carousel), languages                                                    | 2     |
| Mink         | Off / Mink helps / Mink drafts; answer-only; hands over                                                                                                                 | 2     |
| Commerce     | Catalogue sync (Commerce Manager), cart, `order` webhook → order, address capture, summary, payment link + COD                                                          | 3     |
| Commerce     | WhatsApp order book in Orders; analytics "sales by channel"                                                                                                             | 3     |
| Commerce     | Click-to-WhatsApp ad attribution (`referral` in webhook, 72-h free window)                                                                                              | 3     |
| Growth       | Broadcasts: segments (`user_groups`, bought X, lapsed), cost preview, schedule, STOP, per-user-limit reporting                                                          | 4     |
| Growth       | Abandoned cart (needs persisted cart), back-in-stock, reorder, review request                                                                                           | 4     |
| Commerce     | In-chat payments (`order_details` / Enhanced Payment Links)                                                                                                             | 4     |
| POS          | Receipt on WhatsApp (document-header utility template) — roadmap Step 5                                                                                                 | 4     |
| Calling      | Business Calling API                                                                                                                                                    | —     |
| Multi-number | Several numbers per store                                                                                                                                               | —     |

---

## 5. Seller journey

Connecting works like Razorpay today — the seller links **their own** account —
except Meta's Embedded Signup popup does the work, so nobody copies keys.

1. **Channels → WhatsApp → Connect.** Before the popup, ONE question (§7):
   _"Is this number already on the WhatsApp Business app?"_ → Coexistence path,
   or _"Use a new number"_.
2. **Meta's popup:** Facebook login → pick/create business → enter number →
   OTP. Returns a code; the server exchanges it for a **business token**
   (server-to-server, never in the browser), **subscribes the app to the
   WABA** (`POST /{WABA_ID}/subscribed_apps` — ★ NOT optional: Phase 0 found
   that a WABA with every webhook field subscribed still delivers nothing to
   an app that is not subscribed to that WABA, and nothing reports it; see
   `docs/whatsapp-phase0.md` §4.2), registers the number with a 2FA PIN we
   generate and store encrypted.
3. **Back in StoreMink:** "✅ Connected: +91 98xxx xxxxx", display name
   status, profile prefilled from the store (logo, address, website), and the
   template bootstrap running: every customer/team event StoreMink ships a
   template for is submitted in the store's language(s) and the card shows each
   one's status.
4. **Next steps card** (never hidden): add a payment method in WhatsApp Manager
   (or nothing sends), verify the business (tier 250 → 1,000), display-name
   approval, INR billing.
5. **Switch on features**: notification channel switches per event (the console
   §24 already has), auto-replies, Mink mode.

**Plan:** connection and notifications **Basic+** (like `onlinePayments`);
broadcasts **Pro** (like `emailCampaigns`); inbox and ordering at Basic+.

---

## 6. Customer journeys (unchanged from v1 in substance)

**A. Website order.** Checkout has "Get order updates on WhatsApp", ticked by
default, with a separate unticked box for offers. ★ **The box renders only when
the store has a connected, enabled WhatsApp account** (owner, 2026-10-08) —
`getCheckoutConfig` carries `whatsapp: boolean` the way it carries `demo` and
`closed`, so a merchant with nothing connected never collects a consent they
cannot honour (§25's rule for a policy box over a blank page). Updates arrive as
utility templates; COD gets ✅/❌ buttons; replies land in the inbox.

**B. Ordering inside WhatsApp.** Chat button / QR / "Hi" → welcome with menu
buttons → catalogue → WhatsApp cart → "send cart" arrives as an `order`
webhook → address via the native address message (India) with "deliver to
saved address?" for known customers → summary (items, automatic offers,
delivery charge, total) with **Pay now** (Razorpay payment link) or **COD** →
confirmation and the same updates as A. The order is an ordinary row in
Orders, book "WhatsApp".

**C. Coming back.** Abandoned-cart reminder (Phase 4), broadcasts to marketing
opt-ins, STOP always works.

**D. Asking a question.** Fixed replies → Mink (if enabled) → human, with the
whole chat and the customer's orders beside it.

---

## 7. Decision — Coexistence is supported from day one, and chosen before the popup

Most Indian shop numbers are already on the WhatsApp Business app. Without
Coexistence the merchant needs a fresh SIM, which for a small shop is the end
of the conversation. So the connect flow asks first and routes to Meta's
Coexistence onboarding when the answer is yes.

- ★ **The inbox must handle echo messages.** Under Coexistence the merchant
  also replies from their phone; those replies arrive at our webhook as
  outbound echoes and must render as "sent from phone" in the thread, never as
  inbound customer messages and never re-sent.
- ★ **Sending speed is capped (~20 msg/s) on a coexistence number.** The
  broadcast worker paces per number; it is a per-number setting read from the
  account row, not a constant.
- Groups, disappearing messages and view-once are not synced; the connect
  screen says so before the click.

✅ **Settled: day one** (owner, 2026-10-08; §19.1). The connect flow in Phase 1
ships both paths.

---

## 8. Decision — the channel rides the notification spine; the template is the switch

A WhatsApp notification is the SMS channel with a better provider. Same four
tables, same fan-out branch, same worker, same choke point, same log, same
Failures source — because §37's reasoning holds unchanged:

- `available` on `CHANNELS.whatsapp` is a **platform** statement and flips only
  once provider + template + switch all exist. Deliverability per store is three
  conditions resolved at fan-out in `lib/whatsapp/channel.ts`: a connected and
  enabled account, the merchant's per-event per-audience switch, and an
  **approved** template for that event, audience and language.
- ★ **`whatsapp` gains no field on `EventDef.audiences`**, for the same reason
  `sms` has none: there is no defensible platform default; the approved template
  is the merchant's statement of intent.
- ★ **Template status is read at fan-out, not at send.** A paused or rejected
  template means the row is never queued, and the event's channel toggle shows
  "template paused by Meta" with a link to the template manager. Queuing and
  failing would fill the log with failures the merchant cannot act on from it.
- Variables are **positional** (`{{1}}`…), mapped from the event's
  `variableNamesFor` exactly as `renderDltBody` maps DLT bodies; the same
  `formatVariable` output feeds both, so a WhatsApp message prints ₹1,240.00 and
  "28 July 2026", never `1240` and an ISO string (§24's lesson).
- ★ **Unlike SMS, delivery IS known.** The status webhook (sent/delivered/
  read/failed with Meta's error code) updates `whatsapp_logs`, so the log says
  "delivered 14:02, read 14:05" or "failed 131026: not a WhatsApp user". The
  §37 caveat ("sent ≠ delivered") is not repeated here.
- **Precedence with SMS** (✅ settled, §19.3): a customer opted into both gets
  ONE message per event, and **WhatsApp wins**. `whatsapp.updatePrecedence`
  (`whatsapp_first` | `sms_first` | `both`) decides at fan-out, default
  `whatsapp_first`; SMS is the fallback when the contact has no WhatsApp opt-in
  or the template is not approved.
- Team audience: staff phones come from `admins.phone` (verified at signup,
  §34) — a team alert needs no separate opt-in beyond the staff member's own
  preference in `/notifications/me`.

---

## 9. Decision — one app-level webhook, one secret, routed by phone number

Meta posts to ONE URL per app for every WABA onboarded through it.

- `POST /api/webhooks/whatsapp` verifies `X-Hub-Signature-256` (HMAC-SHA256 of
  the RAW body with the app secret — the Razorpay webhook's pattern) before
  parsing anything; `GET` answers the verify-token challenge.
- ★ **Routing is by `metadata.phone_number_id`, never by anything inside the
  message.** The phone number id maps to exactly one `store_whatsapp_accounts`
  row; an unknown id is logged and 200'd (Meta retries 4xx/5xx for days).
- ★ **Idempotent on `messages[].id` / `statuses[].id`.** Meta redelivers; a
  UNIQUE on `(account_id, provider_message_id)` turns a redelivery into a no-op
  rather than a duplicate inbound message or a double COD cancellation.
- ★ **200 fast, work later.** The handler inserts raw events into
  `whatsapp_inbound_events` and returns; a worker on the send-emails heartbeat
  (and `after()` for latency) processes them: inbound message → inbox row +
  `last_inbound_at`; status → log update; `button`/`interactive` reply → COD
  confirm/cancel or menu; `order` → the ordering flow (§12); `referral` → CTWA
  attribution on the conversation; `message_template_status_update` → template
  table; `account_update` → tier/quality/INR flags; echo (Coexistence) →
  outbound row marked `from_phone`.
- Payloads are service-only and pruned (§32) — they carry customer text.

---

## 10. Decision — contacts, consent and the window are one table

`whatsapp_contacts` (store, phone E.164, `wa_id`, profile name, `user_id` →
`users` when known) carries:

- `updates_opt_in_at` + `updates_consent_text` and `marketing_opt_in_at` +
  `marketing_consent_text` + `marketing_opt_out_at` — TWO consents, recorded
  the way `newsletter_subscribers` records one, because Meta's rules and the
  merchant's reputation treat them differently.
- `last_inbound_at` — the 24-hour window clock, written by every inbound
  message. ★ A template send does NOT open the window; only the customer does.
- `referral` (last CTWA ad id/source, with its 72-hour free-window start).
- ★ **Phone is the identity; `users` is joined, not required.** An unknown
  sender gets a contact row immediately and a phone-only `users` row only when
  they order (the §36 `pos_` claimable pattern, so a later signup adopts their
  history). `storedPhoneVariants` is used for every join — a legacy national
  number must still match a `wa_id`.
- ★ **STOP is checked at SEND, not at enqueue** (§37's rule): a customer can
  opt out between a broadcast being scheduled and drained. Any inbound
  "stop/unsubscribe" (`classifyInbound`'s vocabulary, extended for Hindi) sets
  `marketing_opt_out_at`; updates continue, since they are transactional.

---

## 11. Decision — the inbox ships in Phase 1, because Phase 1 sends

The moment a customer receives "Order confirmed" they reply to it. With no inbox
those replies land nowhere, which is worse than not sending. Phase 1 therefore
includes a BASIC inbox; Phase 2 grows it.

- New permission section **`inbox`** (group Workspace, view/manage), its own
  sidebar entry with a needs-reply badge — a count that demands action and
  goes away (§22's badge rule), fed by a single indexed COUNT.
- `whatsapp_conversations` (store, contact, status open/needs_reply/closed,
  assigned admin, last message at, window expires at, unread count) and
  `whatsapp_messages` (direction, kind text/image/document/audio/location/
  contact/order/template/button, body, media path in GCS, quoted id,
  provider id, status, from_phone for echoes).
- ★ **Polling is a route handler, never a server action** (`/api/pos/live`'s
  lesson): a 10-second inbox poll must not queue in front of a staff member's
  reply. `use-poll`'s visibility/online gates and backoff are reused directly.
- Reply inside the window is free-form; outside it the composer offers only
  approved templates, with the window countdown visible. ★ The server
  re-checks the window — the composer's state is a hint.
- Media inbound is fetched from Meta with the business token and stored under
  `stores/{id}/whatsapp/` in GCS (never hot-linked: Meta media URLs expire and
  need the token); outbound media is uploaded to Meta first.
- Customer panel: orders for that phone (`getMyOrders`' store-scoped read with
  the phone instead of a session), store credit, saved address, opt-in state.
- Phase 2 adds assignment, labels, notes, canned replies, business hours and
  the away message, search, and the phone layout (the `use-mobile` sheet
  pattern from Orders).

---

## 12. Decision — a WhatsApp order is an ordinary order, priced by the checkout core

Nothing from the chat is trusted for money. The `order` webhook carries
`product_items` (retailer_id = variant SKU, quantity, the price the catalogue
showed); only the SKU and quantity are read.

- ★ **Extract `placeOrder`'s core.** Today it begins with `getServerUser()` and
  reads the cart from the client; the pricing / offers / stock reservation /
  tax / shipping / gift / coupon-fallback chain beneath that is what every
  channel must share — §27's "one implementation, N callers" rule, and the
  `posTotals` lesson in reverse (a second pricing path drifts within a week).
  `placeOrderFor(customer, lines, address, paymentMethod, …)` takes a
  server-resolved customer; `placeOrder` becomes a thin session wrapper over it.
- `orders.sales_channel` CHECK widens to `('online','pos','whatsapp')`;
  `pos_06`'s file is applied, so this is its own forward-only migration. The
  Orders workspace gains a **WhatsApp** book (gated like the POS book on the
  channel being connected), analytics "sales by channel" gains the row, and
  `history-channels.ts` groups it under Online for the shopper.
- Address: the native **address message** interactive type (India) with the
  saved address offered first; the reply is validated like checkout's
  (`formatIndianMobile`, PIN, state) and saved to `customer_addresses`.
- Summary message: items, automatic offers (`resolveOffersForCart` with the
  real pair of prices — §38's "every surface gets the same pair"), delivery via
  the shipping quote, total; buttons **Pay now** / **Cash on delivery**, each
  allowed only when `paymentOptionsFor` allows it (§23's one rule for the
  picker and the server).
- **Pay now** = a Razorpay Payment Link on the store's BYO account
  (`lib/payments/razorpay.ts` gains `rzpCreatePaymentLink`), the order written
  `pending` exactly as the website's online path, settled by the existing
  store webhook (§18) or reconcile-on-read, reaped by the existing cron. ★ No
  new way to mark an order paid.
- Stock: `holdStock` while the summary is open? **No** — the website reserves
  at `placeOrder`, so does this: the summary is a quote, the order is placed
  on the button press, and a stale quote is re-priced then (the §22 park rule:
  a held cart holds nothing).
- Variants: the catalogue is flat, one item per sellable SKU; a product with
  options is N items named "Shirt — M / Black" (§11's composed variant name),
  so the picker problem never reaches the chat.

---

## 13. Decision — customer-facing Mink is a new bounded actor, answer-only

The dashboard agent (§20a) resolves a trusted ADMIN with permissions; nothing
about it can be pointed at a shopper. The public Help assistant is the
precedent: stateless per turn, grounded only in retrieved rows, every claim
validated against what was retrieved, falls back to "I don't know" rather than
a guess.

- **Reads, all scoped to the contact's phone and the store:** that customer's
  orders and shipment events; stock for a named product (`isSoldOut`, by
  variant); delivery to a PIN (`quoteProductDeliveryByPin`, the PDP's public
  action); current offers (`list_current_offers`'s read); store policies
  (§25's `store_pages` policy slugs); business hours.
- ★ **No writes, no tools that act.** It cannot cancel, refund, change a price,
  apply a code or edit an address; those are hand-over triggers. This is not a
  gate to flip later — the whole safety argument is structural, like Mink's
  product-image rule (§9E).
- ★ **Hand over is the default outcome, not the exception.** Low retrieval
  confidence, a complaint/refund/damage vocabulary, "talk to a person", or any
  question outside the read list → `needs_reply` with Mink's draft attached as
  an internal note.
- Modes: `off` (fixed replies only), `helps` (Mink answers inside its read
  list, hands over the rest), `drafts` (staff approve every reply). `helps` is
  the recommended default; `off` is the shipped default (new behaviour on a
  live store is the merchant's decision, invariant 1 of every registry entry).
- Credits: one Mink credit per sent answer from the same pool (§16), via a
  separate `consume_mink_whatsapp_answer` that fails CLOSED (a store out of
  credits gets the human path, never a free answer that bills later).
- Prompt is an executable Markdown doc (`docs/mink-ai-whatsapp-prompt.md`,
  validated like the other two), with its own eval set under `evals/mink/`.
  Inbound text is untrusted input inside the prompt, fenced, never a system
  instruction.

---

## 14. Decision — broadcasts reuse Phase 5E's shape, and the rate card is data

A broadcast is a coupon-email campaign with WhatsApp delivery: audience
resolved to an exact snapshot (`user_groups`, "bought X", "last order before
date", marketing opt-in only), non-PII preview, cost preview, final confirm,
scheduled claim with `FOR UPDATE SKIP LOCKED`, worker on the heartbeat.

- ★ **Cost preview reads `whatsapp_rate_card`**, a platform-operator table
  (`/dashboard/pricing` beside credit packs) keyed by country and category.
  Nothing in code carries ₹0.86. The preview says "about ₹1,036 + GST, billed
  by Meta to your account" and the campaign report shows the real count by
  outcome.
- ★ **Tier-aware.** A campaign larger than the number's remaining daily tier
  is refused up front with the number, not queued to fail at message 251.
- Outcomes per recipient: delivered, read, failed (Meta code), **user limit**
  (131049) and opted out — five, because "sent 1,000, 180 failed" is not
  actionable.
- Templates with **copy-code** buttons carry an offer code; a **URL** button
  deep-links to the storefront with the code pre-applied.
- Pro only, like `emailCampaigns`; one marketing message per contact per
  campaign. **Frequency is the seller's setting** (✅ §19.5):
  `whatsapp.marketingFrequency` — at most N marketing messages per contact per
  D days, across every campaign (registry defaults 1 per 1 day; `0` = no limit).
  The audience resolver skips contacts over their limit and reports them as
  their own outcome, so "this will go to 1,200" is the number that will
  actually be sent. ★ Meta's own per-user cap still applies on top, which is
  why the report keeps "user limit" as a separate line.

---

## 15. Schema sketch

All service-only, RLS forced, app-user revoked, store-composite FKs where a
child references two parents (0052's pattern).

```
store_whatsapp_accounts      -- one per store
  store_id PK/FK, waba_id, phone_number_id, display_phone, display_name,
  display_name_status, business_token_enc, two_fa_pin_enc, app_subscribed_at,
  coexistence bool, messaging_tier, quality_rating, inr_billing bool,
  status (connected|paused|needs_reauth|disconnected), enabled bool,
  send_rate_per_sec int, catalog_id null, payment_config_name null,
  created_at, updated_at

whatsapp_templates           -- the mirror + manager
  id, store_id, event_key null, audience null, name, language, category
  (utility|marketing|authentication), components jsonb, variables text[],
  provider_template_id, status (pending|approved|rejected|paused|disabled),
  rejection_reason, quality, enabled bool, UNIQUE (store_id, name, language)

whatsapp_contacts            -- §10
  id, store_id, phone, wa_id, profile_name, user_id null,
  updates_opt_in_at, updates_consent_text, marketing_opt_in_at,
  marketing_consent_text, marketing_opt_out_at, last_inbound_at,
  referral jsonb, UNIQUE (store_id, phone)

whatsapp_conversations / whatsapp_messages   -- §11
whatsapp_inbound_events      -- raw webhook payloads, UNIQUE (phone_number_id, event_id), pruned
notification_whatsapp_queue  -- the SMS queue shape + template_id + recipient contact
whatsapp_logs                -- every send: status timeline, category, pricing tag
                                (free_customer_service etc.), error code
whatsapp_campaigns / whatsapp_campaign_recipients  -- Phase 4, the email_campaigns shape
whatsapp_rate_card           -- platform singleton-ish: country, category, inr_paise, effective_from
whatsapp_catalog_items       -- Phase 3: variant_id → retailer_id, last synced hash, meta status/rejection
carts                        -- Phase 4 prerequisite: persisted cart per customer/contact
```

Widened: `orders.sales_channel` CHECK; `users.marketing_opt_in`-style flags
are NOT added to `users` (consent belongs on the contact row with its text).

Settings registry (`whatsapp.*`, section `channels` or `inbox`): `updatePrecedence`,
`welcomeMessage`, `awayMessage`, `businessHours`, `menuButtons`,
`codConfirmation` (off | ask | ask_and_autocancel_after_hours),
`minkMode` (off | helps | drafts), `autoReplyOrderStatus`,
`marketingFrequency` (count + days, §14).

Plan limits: `whatsapp` (Basic+), `whatsappBroadcasts` (Pro).

---

## 16. Build order

| Phase | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Gate to the next                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **0** | StoreMink's Meta app: Business Verification, App Review videos, Access Verification, Embedded Signup (v4 phone-first) + Coexistence configuration, app secret + verify token in Secret Manager, webhook route stub answering the challenge, system-user token, test WABA. **No merchant code.** ◐ **Code half shipped 2026-10-08** (`app/api/webhooks/whatsapp`, `lib/whatsapp/webhook-*`, `npm run whatsapp:smoke`); console half is the checklist in `docs/whatsapp-phase0.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Advanced Access granted; a test message sent and received on a sandbox number.         |
| **1** | ◐ **Slices 1–3 built 2026-10-08** — slice 1 (connect): Channels card, Embedded Signup exchange, account table, WABA subscription, inbound-event rows; slice 2 (notify): template catalogue + bootstrap + status webhook, fan-out branch with `whatsapp.updatePrecedence`, queue, worker, choke point + coverage test, log with Meta's delivery timeline, Failures source + log rail, checkout opt-in, Help guide; slice 3 (inbox): `inbox` permission + sidebar badge, one conversation per contact with every message in both directions, inbound messages of every type with media copied into our bucket, Coexistence echoes, STOP/START in three scripts, free-text replies inside the 24-hour window and approved templates after it, the customer strip, the poll route, the account-page WhatsApp card, the storefront chat button + the Channels QR, Help guide (`docs/whatsapp-acceptance.md` WA-1.x–WA-3.x). **Code complete; live verification waits on the configuration id.** | One live merchant receiving replies in the inbox; SMS precedence proven on one event.  |
| **2** | Full inbox; auto-replies, hours, menu buttons; COD confirm/cancel (reusing `approve-cancellation.ts`); template manager; customer-facing Mink (`helps`/`drafts`) with its prompt doc and evals; retention entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Mink eval gate green; one merchant on `helps` for a week with hand-over rate measured. |
| **3** | Catalogue sync (Commerce Manager, variant items, `content_updated_at` watermark, availability on stock change, rejections surfaced); `order` webhook → `placeOrderFor`; address message; summary; Razorpay payment link + COD; WhatsApp order book; CTWA attribution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A real order placed from a phone, paid by link, shipped by Shiprocket, refunded.       |
| **4** | Broadcasts (§14) + rate card; persisted carts → abandoned-cart; back-in-stock/reorder/review automations; POS receipt on WhatsApp (Step 5); in-chat payments via Enhanced Payment Links, verified live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                      |

Each phase updates `CODEBASE.md`, adds its stories to a new
`docs/whatsapp-acceptance.md` (the pos-acceptance pattern), and publishes Help
guides only for what a merchant can do (AGENTS.md's gate).

---

## 17. Considered and rejected

- **Twilio's WhatsApp API through the existing BYO Twilio** as a Phase 0
  shortcut. It needs the same Meta approvals via Twilio's Embedded Signup, adds
  Twilio's per-message markup, and gives no catalogue/payments/Flows. Direct
  Cloud API only.
- **StoreMink as Solution Partner with a credit line (we pay Meta, re-bill).**
  Simpler for the merchant, but it makes StoreMink the billing party for
  message money — collection, GST invoicing and disputes — for a feature whose
  whole cost story is "you pay Meta's price". Tech Provider; merchant pays Meta.
- **A hardcoded rate card.** Meta changes rates quarterly; a constant is wrong
  within months and shows the merchant a confident wrong number.
- **Holding stock while a WhatsApp summary is open.** The park rule (§22):
  abandoned chats would strand stock.
- **Mink with any write tool, however gated.** The customer-facing boundary is
  structural or it is nothing.
- **Reusing `enquiries` as the inbox.** A form submission has no thread, no
  window, no media, no status; retrofitting it costs more than a new model.
- **Business Calling, multiple numbers per store, Flows-built checkout.** Not
  in parity scope; revisit on demand.

---

## 18. Review notes from v1 (why v2 differs)

- v1's prices came from aggregator blogs that contradict each other; Meta's own
  page is the authority and India is not in the Oct 2026 changes. Hence §14's
  rate-card table.
- v1 said setup is free and verification is optional. Setup is free for the
  merchant; StoreMink's own Meta approvals are Phase 0, and an unverified
  merchant is capped at 250 customers/day, which breaks broadcasts.
- v1 did not mention Coexistence — the decision that determines whether a
  typical Indian shop can connect at all (§7).
- v1 put the inbox in Phase 2 while Phase 1 sends messages customers reply to
  (§11).
- v1 listed ten features; parity is roughly thirty (§4): template manager,
  delivery status, number health, spend, CTWA attribution, team alerts, the
  full inbox feature set, automations, segments.
- v1 assumed abandoned-cart reminders are a message; they are first a persisted
  cart (§1, §16 Phase 4).
- v1 assumed "customers can reply STOP" is Meta's job; it is ours (§10), and
  Meta's per-user marketing cap is a separate outcome to report (§14).

---

## 19. Decisions — all settled (owner, 2026-10-08)

1. **Coexistence on day one** (§7) — ✅ **yes.** Both paths ship in Phase 1.
2. **Checkout opt-in** (§6A) — ✅ **ticked for order updates, and shown only
   when the seller has connected WhatsApp.** A separate unticked box for
   offers. No consent is collected for a channel that cannot deliver.
3. **SMS vs WhatsApp precedence** (§8) — ✅ **WhatsApp.** A customer opted into
   both gets the WhatsApp message; SMS is the fallback, never a duplicate.
4. **Plan gates** (§5) — ✅ **connect, order updates, inbox and in-chat
   ordering at Basic and above** (`PLAN_LIMITS.whatsapp`, like
   `onlinePayments`); **broadcasts Pro only** (`whatsappBroadcasts`, like
   `emailCampaigns`).
5. **Marketing frequency** (§14) — ✅ **the seller configures it**
   (`whatsapp.marketingFrequency`); the registry default is one per contact per
   day, and Meta's per-user cap applies on top regardless.
6. **Mink credit per WhatsApp answer** (§13) — ✅ **1 credit**, flat, from the
   shared pool; no banding.
7. **Platform fee per message** — ✅ **none.** The merchant pays Meta's price
   and StoreMink's plan price, nothing else; §17's rejection of a markup stands.

---

## Sources

- Meta — [WhatsApp Business Platform pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- Meta — [Get started for Tech Providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- Meta — [App Review for solution providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)
- Meta — [Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/)
- Meta — [Payments India overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-in/overview)
- Meta — [Changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)
- Third-party, unverified: [Coexistence guide](https://sendseven.com/en/blog/whatsapp-coexistence-guide-2026), [India rate card](https://chatmaxima.com/whatsapp-api-pricing/india/)
