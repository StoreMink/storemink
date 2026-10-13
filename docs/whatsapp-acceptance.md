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
token lists the StoreMink app. _Not yet verified: the Dev app's configuration
exists (2026-10-11, runbook §4.3) and dev has carried its ID since 2026-10-13
(the `storemink-web-dev` trigger and the running service); waits on a live
run._

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

## Phase 1, slice 2 — Order updates (2026-10-08)

**WA-2.1 — Connecting registers the templates.** Finish WA-1.3. The card's
_Order update templates_ line reads "0 of 19 approved by Meta · 19 still in
review" within a few seconds; in WhatsApp Manager → Message templates the 19
`sm_*` templates are listed as In review. Pressing **Set up templates** again
reports "Templates are up to date" and creates nothing at Meta. _Pinned by
`templates.test.ts`; not yet run against live Meta._

**WA-2.2 — Meta's verdict reaches the console.** When Meta approves
`sm_order_placed_customer_v1`, Settings → Notifications → New order → WhatsApp
tab shows **Approved** with the exact wording, rendered with sample values,
without anyone pressing Refresh (the status webhook). A rejection shows
**Rejected** and Meta's reason. _Pinned by `inbound.test.ts`._

**WA-2.3 — The switch needs a number, not an approval.** On a store with no
WhatsApp connected, ticking WhatsApp on any notification is refused with
"Connect your WhatsApp number in Channels first". On a connected store it
saves while the template is still in review; nothing sends until approval,
and the tab says so. _Pinned by `notification-actions.test.ts`._

**WA-2.4 — The checkout asks, only when it can deliver.** On a store with no
WhatsApp connected the checkout shows no WhatsApp boxes. On a connected store
two boxes sit under the policy line: _Send me order updates on WhatsApp_
(ticked) and _Also send me offers and news on WhatsApp_ (unticked). Placing
the order writes one `whatsapp_contacts` row for the delivery phone with
`updates_opt_in_at` set and `marketing_opt_in_at` null, and the exact box
wording in `updates_consent_text`. _Pinned by `consent.test.ts` and
`checkout-actions.test.ts`._

**WA-2.5 — A consenting customer gets the WhatsApp, not the SMS.** With both
channels on for New order, Twilio connected, the DLT and WhatsApp templates
both approved, and the customer opted in: one `notification_whatsapp_queue`
row, no `notification_sms_queue` row, and within a minute a `whatsapp_logs`
row reading _Sent_, then _Delivered_, then _Read_ with times, as the handset
receives and opens it. With the box unticked the SMS goes instead. _Pinned by
`record-whatsapp.test.ts`; the live half waits on WA-2.1._

**WA-2.6 — A failure says why.** Place an order with a number that is not on
WhatsApp: the log row reads _Failed_ with "131026: …" and the same row appears
under Logs → Failures → WhatsApp. The queue row is not retried. _Pinned by
`worker.test.ts` and `send.test.ts`._

**WA-2.7 — Precedence is the merchant's.** Settings → Channels → WhatsApp →
Settings, choose _SMS, with WhatsApp as the fallback_: the next qualifying
order sends the SMS only. Choose _Both_: both go. _Pinned by
`record-whatsapp.test.ts` and `channel.test.ts`._

**WA-2.8 — A lapsed plan pauses, never deletes.** Move the store to Free: the
card still shows the connection, no WhatsApp row is queued, the SMS fallback
applies, and moving back to Basic resumes without reconnecting. _Pinned by
`channel.test.ts`._

---

## Phase 1, slice 3 — The inbox (2026-10-08)

**WA-3.1 — Inbox appears with the number.** On a store with no WhatsApp
connected the sidebar has no Inbox entry and `/dashboard/inbox` shows
"Connect a WhatsApp number to use the inbox" linking to Channels (or to Plans
on Free). After WA-1.3, **Inbox** appears under Workspace. A role without
`inbox: view` never sees it; a role with view but not manage can read a
conversation and sees "You can read this conversation but not reply". _Pinned
by `inbox-actions.test.ts` and `inbox-client.test.tsx`._

**WA-3.2 — A reply becomes a conversation.** The customer from WA-2.5 replies
"Is it in stock?" to their order update. Within seconds: Inbox's badge reads
**1**, the bell shows "New WhatsApp message · Rohan · Is it in stock?", and
the conversation is listed under **Needs reply** with the customer's WhatsApp
name, the preview and an unread count. Opening it shows the order update that
was sent and the reply beneath it, and clears the unread count; the badge does
not change, because nobody has answered. Meta redelivering the same message
adds nothing. _Pinned by `inbox.test.ts` (dedupe, bump, bell-once) and
`inbox-parse.test.ts`; the live half waits on WA-1.3._

**WA-3.3 — Replying inside the window.** Type "Yes, two left" and press
Enter: the handset receives it from the store's number, the bubble shows one
tick, then two, then blue as Meta reports delivered and read; the conversation
moves to **Open** and the badge drops. The same row appears under Logs →
WhatsApp logs. Above the box: "You can reply freely for 23 h 58 min". _Pinned
by `inbox-actions.test.ts`, `send.test.ts`, `inbound.test.ts`._

**WA-3.4 — After 24 hours only a template.** On a conversation whose last
customer message is older than a day, the reply box is replaced by "WhatsApp
allows only an approved template until they message again" and a template
picker listing the store's approved customer templates; each `{{n}}` becomes a
field, and Send is disabled until every one is filled. A reply forced through
the action anyway is refused with `window_closed`, and nothing is sent. The
customer writing again restores the free-text box. _Pinned by
`inbox-actions.test.ts` and `inbox-client.test.tsx`._

**WA-3.5 — Photos, files and places.** The customer sends a photo with a
caption, a PDF and a location pin. The thread shows the photo inline (served
from the store's own bucket, never a Meta URL), the PDF as a named link and
the pin as "📍 name, address"; the list previews read "📷 Photo · caption",
"📄 Document", "📍 …". A file Meta refuses to hand over stays in the thread
with its caption and "(not saved)". _Pinned by `inbox.test.ts`
(`storeInboundMedia`) and `inbox-parse.test.ts`; the live half waits on WA-1.3._

**WA-3.6 — Replies from the merchant's phone.** On a Coexistence number, the
merchant answers a customer from the WhatsApp Business app. The reply appears
in the dashboard thread marked "From your phone", the conversation moves to
**Open**, and the 24-hour countdown does NOT restart (only the customer's
messages do that). _Pinned by `inbound.test.ts` (echo rows) and
`inbox.test.ts` (`recordEchoMessage`); not yet run against live Meta._

**WA-3.7 — STOP ends offers, not updates.** The customer replies "STOP" (or
"band karo", or "बंद करो"). The thread flags the message "Opted out of
offers", the customer strip reads "Order updates · No offers", and the next
qualifying order update still sends; the next marketing send would not. The
customer replying "cancel" changes nothing about consent. Replying "START"
restores offers only for a customer who had agreed to them before. _Pinned by
`inbox-intent.test.ts` and `inbox.test.ts`._

**WA-3.7a — STOP gets an answer and does not wait for staff.** The customer
replies "STOP". Within seconds they get "You will not get offers from … on
WhatsApp any more. You will still get updates about your orders." Inbox shows
the STOP and that automatic reply, and the conversation is not in Needs reply,
the badge does not move and the bell does not ring. A START from a customer who
had agreed to offers gets "You will get offers from … again"; a START from
anyone else is an ordinary message waiting for a person. With the number
paused, the opt-out is still recorded and no reply is sent. _Pinned by
`opt-out-reply.test.ts`, `inbox.test.ts` and `inbound-cod.test.ts`._

**WA-3.8 — The customer strip.** Opening **Details** on a conversation shows
what the customer agreed to, their store credit when the number matches an
account on this store, a link to their customer profile, and their five most
recent orders on this store found by account OR by delivery phone (so a guest
checkout is found too), each linking to Orders. _Pinned by the read's
construction in `inbox-read.ts`; not covered by a database probe._

**WA-3.9 — Close and reopen.** **Close** moves a conversation to Closed and
clears its unread count; the customer's next message reopens it as Needs
reply. **Reopen** moves a closed one to Open. Neither sends anything.

**WA-3.9a — Closed chats are deleted after two years.** A conversation that
has been Closed with no message for two years disappears from the inbox on
the next nightly retention run, with its messages and any photos or files the
customer sent; the customer's WhatsApp consent stays on their contact. An Open
or Needs reply conversation of the same age is untouched, and a closed one the
customer wrote to in between has reopened and is untouched too. If a photo
could not be deleted, the whole conversation stays and is tried again the next
night. _Pinned by `lib/whatsapp/retention.test.ts` and `prune.test.ts`._

**WA-3.10 — The customer can change their mind.** A signed-in shopper on a
connected store opens **My account**: a **WhatsApp** card shows two switches
with their current choices. Unticking order updates and saving writes
`updates_opt_out_at`; the next order update goes by SMS or email instead. On a
store with no WhatsApp, or for an account with no mobile number, the card is
absent. _Pinned by `customer-whatsapp-actions.test.ts` and `consent.test.ts`._

**WA-3.11 — Customers can start a chat.** With a connected, live number and
the default settings, every storefront page shows a green **Chat with us**
button bottom-right (an icon alone on phones) opening `wa.me/<number>` with a
prefilled greeting in a new tab; the builder preview never shows it, nor does
a paused number, nor a store whose plan lapsed to Free. Switching **Show a
WhatsApp chat button** off under Channels → WhatsApp → Settings removes it.
The WhatsApp card shows the same link as a QR code with Copy link. _Pinned by
`storefront.test.ts` and `chat-link.test.ts`._

**WA-3.12 — Polling never blocks a reply.** With a conversation open, the
Network tab shows `/api/dashboard/inbox/live?need=thread` every ~8 s and
`need=list` every ~15 s while the tab is visible, stretching to two minutes
when nothing changes and stopping when the tab is hidden; pressing Send is
never queued behind one. Signed out, a poll answers 401. _Pinned by
`use-poll.test.ts` and the route's shape._

**WA-3.13 — It reads like WhatsApp, at any size.** On a laptop, open a
conversation with a long history: the page does not scroll; only the messages
do, the newest is in view and the reply box stays at the bottom. Messages sit
under Today / Yesterday / date pills, and a reply that took several messages
reads as one block. Scroll up: a round arrow appears and takes you back to the
newest; a message arriving while you read history does not pull you down.
Narrow the window (or open Mink) until the card is under 640px: the list and
the chat show one at a time, with a back arrow. On a phone the list fills the
screen and a chat opens full screen; Enter starts a new line and the green
button sends. _Pinned by `inbox-client.test.tsx`; layout measured 2026-10-13 in
a static harness with the real stylesheets at 1280, 880 and 390 px (no page
scroll, no sideways scroll); not yet looked at on a real phone._

**WA-3.14 — The chat button never covers another control.** On a store with
the chat button and analytics (choose Reject optional on the privacy banner),
**Privacy choices** sits bottom-left and the chat button bottom-right, at
every width from 320px up. On a phone product page whose theme has the sticky
Add to cart bar, scroll past the page's own button: both lift above the bar,
and neither covers Add to cart. Scroll to the very end of any page, on every
footer layout: the footer's last line (Powered by, Privacy, Terms) is fully
visible and tappable. On a blog post on a phone, Privacy choices sits above
the reaction bar, and the reactions open over it. _Pinned by
`app/(storefront)/floating-controls.test.ts`; positions measured in Chrome._

---

## Phase 2, slice 1 — COD confirmation (2026-10-13)

**WA-4.1 — Off until the merchant turns it on.** On a connected store,
Channels → WhatsApp → Settings shows **Ask cash-on-delivery customers to
confirm on WhatsApp**, off. With it off, a cash-on-delivery order sends the
usual order message and the order list shows no WhatsApp label. _Pinned by
`record-whatsapp.test.ts` ("not when the store has the setting off")._

**WA-4.2 — The template is submitted with the rest.** After the deploy,
**Set up templates** on the WhatsApp card (or a fresh connect) submits
`sm_order_placed_customer_cod_confirm_v1` with two buttons, **Confirm order**
and **Cancel order**. Settings → Notifications → Order placed → WhatsApp shows
it as a second card, "Cash-on-delivery orders", with its review state and the
two buttons. _Pinned by `template-catalog.test.ts`,
`whatsapp-provider-actions.test.ts` and `whatsapp-template-panel.test.tsx`;
accepted as UTILITY by Meta on the dev test account before shipping._

**WA-4.3 — One message, with buttons.** With the setting on and the template
approved, a shopper who ticked WhatsApp updates places a cash-on-delivery
DELIVERY order. Their phone receives one message, "Please confirm your cash on
delivery order ORD… from …", with the two buttons, and NOT the usual order
message as well. The order list shows **Awaiting confirmation on WhatsApp**
under its status. A prepaid order, a collection, or a store whose COD
template is still in review sends the usual message instead. _Pinned by
`record-whatsapp.test.ts` and `worker.test.ts`._

**WA-4.4 — Confirm.** The shopper taps **Confirm order**. Within seconds they
get "Thank you. Order ORD… is confirmed and we will prepare it for delivery."
The order list reads **Confirmed on WhatsApp**. Inbox shows the tap and the
reply, but the conversation is not marked Needs reply, the badge does not
move, and the bell does not ring. Tapping Confirm again gets the same answer
and changes nothing. _Pinned by `cod-confirmation.test.ts`,
`inbox.test.ts` and `inbound-cod.test.ts`._

**WA-4.5 — Cancel before it ships.** On a pending or processing order the
shopper taps **Cancel order**. The order is cancelled exactly as an approved
cancellation is: its stock goes back to the location that reserved it, any
store credit used is returned, the team and the customer get the usual
cancellation notice, and nothing is refunded (nothing was paid). The shopper
gets "Order ORD… has been cancelled. You will not be charged anything for it."
The list reads **Cancelled on WhatsApp**. _Pinned by
`cod-confirmation.test.ts`._

**WA-4.6 — Cancel too late.** On an order already marked shipped, the shopper
taps **Cancel order**. Nothing changes on the order. They are told it has
already been sent out and someone from the shop will reply; the conversation
moves to **Needs reply** with the bell. _Pinned by `cod-confirmation.test.ts`
and `inbound-cod.test.ts`._

**WA-4.7 — Only the order's own phone.** A tap carrying an order's payload
from a phone that is neither the account phone nor the delivery phone, or for
an order that is not cash on delivery, changes nothing and gets no reply; the
conversation goes to a person. _Pinned by `cod-confirmation.test.ts` and
`cod-payload.test.ts`._

**WA-4.7a — A real COD order is recognised.** A website COD order is stored
as `payment_method = 'cash_on_delivery'`; a tap on its buttons confirms or
cancels it. (The first version compared the row against `cod`, the checkout
choice, and refused every real tap; found on dev 2026-10-13.) _Pinned by
`cod-confirmation.test.ts`._

**WA-4.7b — Store credit that pays it all is not cash on delivery.** A shopper
whose store credit covers the whole order, having picked cash on delivery, gets
the usual order message, never the Confirm/Cancel buttons, and the
confirmation's payment line reads "Store credit". _Pinned by
`checkout-actions.test.ts`._

**WA-4.8 — The inbox cannot send it by hand.** After the 24-hour window
closes, the inbox's template picker does not list the COD confirmation, and
forcing it through the send action is refused, because a hand-sent copy would
carry no order. _Pinned by `inbox-actions.test.ts` and `channel.test.ts`._

**WA-4.9 — One reminder after 24 hours.** With confirmation on, a shopper who
has not tapped anything gets the same Confirm/Cancel message once more 24 to
48 hours after the first, and never a third time, however often the hourly
sweep runs. An order the shop has already moved past Pending gets no
reminder, nor does any order when **Remind customers who haven't answered
after 24 hours** is off. Switching the reminder on never reminds orders whose
message went more than two days ago. _Pinned by `cod-sweep.test.ts`._

**WA-4.10 — Automatic cancellation is the merchant's choice.** With **Cancel
orders not confirmed within 48 hours** on, a Pending COD order still awaiting
an answer 48 to 72 hours after the message is cancelled: its stock goes back
on sale, nothing is refunded, the customer gets the cancellation message, the
order's history names the system rather than an admin, and the order list
shows **Not confirmed on WhatsApp**. With it off (the default) nothing is
cancelled. An order whose customer tapped **Confirm order** a moment before
the sweep is not cancelled. _Pinned by `cod-sweep.test.ts` and
`approve-cancellation.test.ts`._

**WA-4.11 — Confirming too late goes to a person.** A shopper whose order was
cancelled automatically taps **Confirm order**: they are told it was cancelled
because it was not confirmed in time, nothing about the order changes, and the
chat lands in **Needs reply** with the bell. A **Cancel order** tap on it is
answered "already cancelled". _Pinned by `cod-confirmation.test.ts`._

---

## Phase 2, slice 2 — Automatic replies (2026-10-13)

**WA-5.1 — Off until the merchant turns it on.** **Inbox → Automatic replies**
shows **Welcome message**, **Away message** and **Order status**, all off, with
the welcome text naming the store. A customer message on a store that has never
saved this page gets no automatic reply. Saving needs **Inbox: manage**; a
viewer with only **Inbox: view** sees the settings greyed out and no Save
button. _Pinned by `whatsapp-auto-reply-actions.test.ts`,
`auto-replies-form.test.tsx` and `answer-automatically.test.ts` ("nothing
switched on")._

**WA-5.2 — The welcome, once.** With the welcome on, a customer who messages
the number for the first time gets the welcome within seconds. Their second
message gets nothing more, and two messages sent at the same moment get one
welcome. The same customer writing again after 14 days with no messages either
way is welcomed again. The conversation still lands in **Needs reply** with the
bell, and the inbox list shows the customer's words, not the welcome. _Pinned
by `answer-automatically.test.ts` (the claim), `inbox.test.ts`
(`welcomeEligible`, automation filing) and a rolled-back probe of the claim
SQL on local Postgres._

**WA-5.3 — The away message, once per closed spell.** With the away message on
and hours Monday to Saturday 10:00 to 19:00, a customer writing on Monday at
21:00 gets the away message; writing again at 22:00, or on Sunday, gets
nothing; writing on Tuesday at 20:00 (the shop opened at 10:00 in between)
gets it again. A customer writing during opening hours gets nothing. A shop
that set every day to Closed (a holiday) sends it once per customer. _Pinned by
`business-hours.test.ts` (`openedBetween`) and `answer-automatically.test.ts`._

**WA-5.4 — Not after a person replied.** Outside hours, staff reply to a
customer from the inbox or from the phone; the customer answers within two
hours and gets no away message. _Pinned by `answer-automatically.test.ts`
("not straight after a person on the team replied")._

**WA-5.5 — Hours past midnight and other zones.** Friday 18:00 to 02:00 shows
"next day" beside the closing time; a message at 01:00 on Saturday is inside
Friday's hours and gets no away message. Changing **Settings → Business time
zone** moves the hours with it. _Pinned by `business-hours.test.ts`, including
a daylight-saving zone._

**WA-5.6 — One message, not two.** A new customer writing outside hours with
both replies on gets ONE message: the welcome, a blank line, the away message.
_Pinned by `answer-automatically.test.ts`._

**WA-5.7 — Where is my order, answered.** With **Order status** on, a customer
whose number placed an order asks "where is my order" (or "order kab aayega",
"मेरा ऑर्डर कहाँ है", "track my order"). Within seconds they get the order
number, the day it was placed, its status in the order page's words, and, once
shipped, the courier and its tracking link; up to three open orders are listed.
The conversation does NOT go to **Needs reply** and the bell does not ring.
Only orders on the account with that phone, or with it as the delivery phone,
are mentioned; a till sale and an online payment never completed are not.
_Pinned by `order-status-reply.test.ts`, `inbox-intent.test.ts`,
`inbound-auto-reply.test.ts` and `answer-automatically.test.ts`._

**WA-5.8 — Where is my order, handed over.** A number with no recent order
asks the same question: they are told someone will reply, and the conversation
waits in **Needs reply** with the bell. A delivery the courier could not
complete, or one returning to the shop, is described and also handed over. A
message such as "my order was not delivered" or "cancel my order" is never
answered automatically. _Pinned by `order-status-reply.test.ts`,
`inbox-intent.test.ts` and `inbound-auto-reply.test.ts`._

**WA-5.9 — A paused number sends nothing and spends nothing.** With the number
paused, a first message gets no welcome; once it is switched back on, the
customer's next message is welcomed. An order question while paused waits for
a person. _Pinned by `answer-automatically.test.ts` ("a paused number claims
nothing")._

**WA-5.10 — An automatic reply never answers for a person.** A customer asks a
question (the conversation is in **Needs reply**), then taps **Confirm order**
on a COD message: the confirmation reply arrives and the conversation stays in
**Needs reply** with its unread count. _Pinned by `inbox.test.ts` ("answers
nobody") and a rolled-back probe of the filing SQL on local Postgres._

---

## Known gaps

| Gap                                                                                                                                                          | Since      | Status                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------- |
| The connect flow has not run against a live Embedded Signup popup; dev has carried the configuration ID since 2026-10-13                                     | 2026-10-08 | Waiting on a live run on dev |
| An unreachable database reads as "not connected" on the Channels card (the SMS card's documented gap, shared)                                                | 2026-10-08 | Open                         |
| Template submission, the status webhook, echoes and media download follow Meta's published shapes but have not run against live Meta                         | 2026-10-08 | With the live verification   |
| Dashboard replies are text only; a photo or file must be sent from the phone                                                                                 | 2026-10-08 | Phase 2                      |
| Coexistence contact/history sync (`smb_app_state_sync`) is recorded, not processed — a thread starts at the first message after connecting                   | 2026-10-08 | Phase 2                      |
| No assignment, labels, notes, canned replies or search inside messages; the thread shows the latest 200 messages                                             | 2026-10-08 | Phase 2                      |
| Inbound media is kept in the public media bucket at an unguessable path, like the Media Library; a customer's photo is as public as a product photo          | 2026-10-08 | Open                         |
| COD confirmation has not run against live Meta: the button payload shapes follow Meta's reference                                                            | 2026-10-13 | With the live verification   |
| A COD customer who did not tick WhatsApp updates is never asked to confirm (SMS has no buttons)                                                              | 2026-10-13 | By design                    |
| The COD reminder and automatic cancellation run only where the hourly order sweep is scheduled, which is production; on dev the route must be called by hand | 2026-10-13 | By design                    |
| Automatic replies are in English, whatever language the customer wrote in; the order question is understood in English, Hinglish and Devanagari Hindi        | 2026-10-13 | Open                         |
| Order updates sent as templates are not filed in the thread, so a customer's first reply to one counts as a first message and gets the welcome               | 2026-10-13 | Open                         |
| Automatic replies have not run against live Meta; they use the same free-text send as inbox replies, which has                                               | 2026-10-13 | With the live verification   |
