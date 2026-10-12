# WhatsApp Commerce — Phase 0 runbook (Meta app setup)

**Spec:** `docs/whatsapp-commerce-plan.md` §16, Phase 0.
**Gate to Phase 1:** Advanced Access granted on the production app, AND one
template message sent from StoreMink's test number and received on a handset,
AND that handset's reply arriving at `/api/webhooks/whatsapp` as a
`whatsapp webhook received` log line.

Phase 0 is almost entirely work in Meta's consoles that only the StoreMink
owner can do (it needs the StoreMink Facebook business login). The code half
shipped on 2026-10-08 and is listed in §7; everything else below is a
checklist, in the order Meta's own flow imposes. Record each id in the table in
§8 as you go — Phase 1 reads it.

> ⚠ Several of these steps are **waits**: Business Verification and App Review
> each take days, and Embedded Signup is capped at **10 merchants per rolling
> 7 days** until all three verifications pass. Start §2–§4 today; §5–§6 can run
> while you wait.

---

## 1. Decisions already made (plan §19)

- Coexistence is supported from day one, so the Embedded Signup configuration
  (§4.3) must be the Coexistence-capable one.
- StoreMink is a **Tech Provider**: merchants pay Meta directly; StoreMink
  never holds a credit line and never re-bills messages.
- **Two Meta apps, one business portfolio.** A Meta app has exactly ONE
  webhook callback URL, and dev and production are different hosts. So:
  `StoreMink` (production, goes through App Review) and `StoreMink Dev`
  (stays in Development mode, used by app admins/testers only). Both live in
  the same StoreMink business portfolio so verification is done once.

---

## 2. Business Verification (the long pole — start first)

Where: `business.facebook.com` → StoreMink portfolio → **Settings → Security
Centre → Business verification**.

1. Legal name, address and phone must match a document you can upload:
   certificate of incorporation / GST registration / Udyam, plus a utility
   bill or bank statement if the address is not on the first document.
2. Website `https://storemink.com`; the domain must be **verified** under
   **Brand Safety and Suitability → Domains** (add `storemink.com`, use the
   meta-tag method — it goes in `app/platform/layout.tsx`'s metadata like the
   Google site-verification tag; ask for it as a code change when you have
   the tag).
3. Confirm the business email/phone when asked.

Typical turnaround: 1–5 business days; rejections usually mean a name/address
mismatch between the document and the portfolio.

---

## 3. Create the two apps

Where: `developers.facebook.com/apps` → **Create App**.

For EACH of `StoreMink` and `StoreMink Dev`:

1. Use case **Other** → app type **Business** → connect to the StoreMink
   portfolio.
2. **Add products:** `WhatsApp` and `Facebook Login for Business`.
3. **Settings → Basic:** record **App ID** and **App Secret** (§8). Fill in:
   - App icon (512×512; `brand/assets/` has the master)
   - Privacy Policy URL: `https://storemink.com/legal/privacy`
   - Terms of Service URL: `https://storemink.com/legal/terms`
   - Category: Business and Pages
   - App domains: `storemink.com`
4. **Settings → Advanced → Security:** leave "Require App Secret" ON.

The dev app stays in **Development** mode permanently. The production app is
switched to **Live** only after App Review (§6).

---

## 4. WhatsApp product configuration (both apps)

Where: app dashboard → **WhatsApp**.

### 4.1 Test number (API Setup)

Meta gives every app a free test phone number with a 24-hour temporary
token. Record its **Phone number ID** and **WABA ID** (§8). Add up to five
recipient handsets under "To" (each gets an OTP). This is what the smoke test
(§7.3) and the App Review video (§6.2) use.

### 4.2 Webhook (Configuration)

The callback URL must answer Meta's handshake at the moment you click
**Verify and save**, so the route must be DEPLOYED first (§7.2).

| App             | Callback URL                                      | Verify token                    |
| --------------- | ------------------------------------------------- | ------------------------------- |
| `StoreMink Dev` | `https://dev.storemink.com/api/webhooks/whatsapp` | `WHATSAPP_VERIFY_TOKEN_STAGING` |
| `StoreMink`     | `https://storemink.com/api/webhooks/whatsapp`     | `WHATSAPP_VERIFY_TOKEN_PROD`    |

Subscribe to these **webhook fields** (the Phase 1 handlers in plan §9 are
named by them):

| Field                             | Why                                                       |
| --------------------------------- | --------------------------------------------------------- |
| `messages`                        | inbound messages, delivery statuses, button/order replies |
| `message_template_status_update`  | approved / rejected / paused — the switch in plan §8      |
| `message_template_quality_update` | quality drops before a pause                              |
| `template_category_update`        | Meta re-categorising a template changes what it costs     |
| `account_update`                  | verification, tier changes, INR migration, bans           |
| `account_alerts`                  | policy warnings                                           |
| `phone_number_quality_update`     | quality rating / messaging tier                           |
| `phone_number_name_update`        | display-name approval                                     |
| `business_capability_update`      | tier limits                                               |
| `smb_message_echoes`              | **Coexistence:** messages the merchant sent from the app  |
| `smb_app_state_sync`              | **Coexistence:** contacts/labels synced from the app      |
| `history`                         | **Coexistence:** the initial chat-history sync            |

Do NOT subscribe `calls` (Business Calling is a non-goal, plan §17).

**★★ SUBSCRIBING THE FIELDS IS NOT SUBSCRIBING THE WABA, and the dashboard
only does the first.** Found on 2026-10-08: with every field subscribed and
the handshake verified, the dashboard's **Test** button delivered (three
sample payloads, all logged) while a real message from a handset never
arrived. `GET /{WABA_ID}/subscribed_apps` showed the test WABA subscribed only
to Meta's own "WADevX Webhook Events 1P App" — the internal app behind the
Test button — and not to StoreMink Dev. Meta posts a WABA's events only to
apps subscribed to THAT WABA, so a subscription has to be made per WABA:

```bash
curl -s -X POST "https://graph.facebook.com/v26.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer <token from the app>"      # → {"success":true}
```

The token decides which app is subscribed. ★ Phase 1's connect flow must make
this call for every merchant's WABA right after the Embedded Signup code is
exchanged (plan §5 step 2) — without it a merchant's inbox stays silent with
nothing failing anywhere, which is exactly what this looked like.

### 4.3 Embedded Signup configuration

Where: app dashboard → **Use cases → Connect with customers through
WhatsApp → Customize → Become a Partner → Embedded Signup Builder**.

★ **Not** Facebook Login for Business → Configurations → Create
configuration: on these use-case apps that wizard offers only the
**General** login variation, which cannot ask for a WhatsApp account
(found 2026-10-11). The builder's own **Create configuration** button
creates the WhatsApp one.

1. **App Setup → Manage Domains:** list every host that opens the popup and
   enable Login with the JavaScript SDK (Facebook Login for Business →
   Settings → Client OAuth settings). Meta returns the WABA and number only to
   a listed domain, and every store's dashboard runs on its own subdomain, so
   the dev app lists the test store's host (`https://echoss.dev.storemink.com/`).
   Whether an unlisted store subdomain also works is not yet verified.
2. **App Setup → Facebook Login for Business Configurations → Create
   configuration:** system-user access token expiring **Never** (StoreMink
   does not renew tokens), WhatsApp Cloud API, WhatsApp accounts,
   `whatsapp_business_management`, `whatsapp_business_messaging`,
   `business_management`. Coexistence needs no separate configuration: the
   connect button passes `featureType` for it (not yet verified live).
3. **App Setup → App Roles:** in Development mode only app admins, developers
   and testers can complete the flow.
4. Record the **Configuration ID** (§8). Phase 1's connect button passes it
   to `FB.login`; the deploy reads it from `_WHATSAPP_CONFIG_ID`.

---

## 5. System user token (production app)

Where: `business.facebook.com` → **Settings → Users → System users**.

1. Create a system user named `storemink-whatsapp`, role **Admin**.
2. **Add assets:** the `StoreMink` app, with "Develop app" / full control.
3. **Generate token:** app `StoreMink`, expiry **Never**, permissions
   `whatsapp_business_management`, `whatsapp_business_messaging`,
   `business_management`.
4. Store it in Secret Manager as `WHATSAPP_SYSTEM_USER_TOKEN_PROD` (§7.1).
   ⚠ It is shown once. Never paste it into a chat, a doc or a trigger
   substitution.

Phase 1 uses it for app-level operations after a merchant's Embedded Signup
code is exchanged (subscribing the app to the merchant's WABA, reading
template status). Repeat for the dev app with `_STAGING`.

---

## 6. App Review and Access Verification (production app only)

### 6.1 Request Advanced Access

Where: app dashboard → **App Review → Permissions and Features**. Request
**Advanced Access** for exactly these three — requesting more is the commonest
rejection reason:

- `whatsapp_business_messaging`
- `whatsapp_business_management`
- `business_management`

### 6.2 Submit for review

The submission needs, per permission, a plain description of the use case
("StoreMink is a commerce platform; merchants connect their own WhatsApp
number to send order updates and reply to customers from their dashboard") and
two screen recordings:

1. **A message sent and received.** Run the smoke test (§7.3) against the test
   number with a recipient handset visible on screen.
2. **A template created.** One `curl` against
   `/{WABA_ID}/message_templates` creating a `utility` template is accepted
   in place of an app UI — Phase 1's template bootstrap does not exist yet, and
   Meta's docs say the cURL route is fine.

Typical turnaround: about a day. A rejection names the permission; fix only
that and resubmit.

### 6.3 Access Verification

Where: app dashboard → **WhatsApp → Become a Tech Provider** (the checklist
page). After 6.2 it offers the Access Verification form: company details,
the website, what the app does. This is what lifts the onboarding cap from 10
to 200 merchants per week.

### 6.4 Switch the app to Live

Only after 6.1–6.3. In Development mode Embedded Signup works for app
admins/testers only, which is all Phase 1 development needs until a real
merchant tries it.

---

## 7. The code half (shipped 2026-10-08)

| Piece                                                   | What it does                                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/api/webhooks/whatsapp/route.ts`                    | GET answers the handshake against `WHATSAPP_VERIFY_TOKEN`; POST verifies `X-Hub-Signature-256` against `WHATSAPP_APP_SECRET` over the raw body, logs a content-free summary, acts on nothing |
| `lib/whatsapp/webhook-signature.ts`                     | the two verifiers (pure, tested, constant-time)                                                                                                                                              |
| `lib/whatsapp/webhook-events.ts`                        | `summarizeWebhook` — counts and ids only, never text or a `wa_id` (pinned by test)                                                                                                           |
| `scripts/whatsapp-smoke.mjs` (`npm run whatsapp:smoke`) | sends one template from the test number; the Phase 0 gate and the App Review video                                                                                                           |

### 7.1 Secrets (create BEFORE the deploy that reads them)

Cloud Run refuses a revision whose `--set-secrets` names a secret that does
not exist (`docs/gcp-ci-cd.md`), so these are created first, then the
`cloudbuild.yaml` change lands, then the deploy. Per environment, like
`PAYMENT_CRED_KEY`: a leaked staging app secret must not verify production
deliveries.

```bash
# App Secret: from Settings → Basic of the matching app
printf '%s' '<dev app secret>'  | gcloud secrets create WHATSAPP_APP_SECRET_STAGING --project=storemink-prod --data-file=-
printf '%s' '<prod app secret>' | gcloud secrets create WHATSAPP_APP_SECRET_PROD    --project=storemink-prod --data-file=-

# Verify token: OURS, any high-entropy string; the same value goes into the Meta console (§4.2)
printf '%s' "$(openssl rand -base64 32 | tr -d '/+=')" | gcloud secrets create WHATSAPP_VERIFY_TOKEN_STAGING --project=storemink-prod --data-file=-
printf '%s' "$(openssl rand -base64 32 | tr -d '/+=')" | gcloud secrets create WHATSAPP_VERIFY_TOKEN_PROD    --project=storemink-prod --data-file=-

# System-user tokens (§5) — Phase 1 reads these; created now so they are not forgotten
printf '%s' '<dev token>'  | gcloud secrets create WHATSAPP_SYSTEM_USER_TOKEN_STAGING --project=storemink-prod --data-file=-
printf '%s' '<prod token>' | gcloud secrets create WHATSAPP_SYSTEM_USER_TOKEN_PROD    --project=storemink-prod --data-file=-
```

Grant the Cloud Run runtime service account `roles/secretmanager.secretAccessor`
on each (the same grant the existing secrets carry).

### 7.2 Wiring and deploy

✅ **Done 2026-10-08.** All four secrets exist, `cloudbuild.yaml` reads
`WHATSAPP_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN` from them and passes
`WHATSAPP_APP_ID` / `WHATSAPP_CONFIG_ID` as plain env vars (defaults = the
dev app), and the `storemink-web-prod` trigger overrides all three to the prod
app and `*_PROD` secrets (verified with `gcloud builds triggers describe`).
`_WHATSAPP_CONFIG_ID` defaults to empty. The `storemink-web-dev` trigger has
carried the dev configuration (`1080489094597122`) since 2026-10-13; the prod
trigger stays empty until the production app has its own configuration.

Remaining: merge `whatsapp` → `dev` so `dev.storemink.com` serves the route,
wait for the dev build, then click **Verify and save** in §4.2. The verify
token to paste there is read with (never pasted into chat or a doc):

```bash
gcloud secrets versions access latest --secret=WHATSAPP_VERIFY_TOKEN_STAGING --project=storemink-prod; echo
```

### 7.3 Smoke test

```bash
WHATSAPP_ACCESS_TOKEN='<temporary token from API Setup>' \
WHATSAPP_PHONE_NUMBER_ID='<test number id>' \
npm run whatsapp:smoke -- --to=+91XXXXXXXXXX --dry-run     # shows the request
npm run whatsapp:smoke -- --to=+91XXXXXXXXXX --yes         # sends hello_world
```

Reply from the handset. In Cloud Logging for `storemink-web-dev`, filter
`jsonPayload.message="whatsapp webhook received"`; the line shows
`phoneNumberIds`, `messages: {text: 1}` and nothing else. That is the gate.

✅ **Passed 2026-10-08.** `hello_world` from the Dev test number reached the
owner's handset at 19:20 IST; the handset's reply was logged at 14:10:26 UTC
as `wabaIds: [2323545385144849]`, `phoneNumberIds: [1280649011808874]`,
`messages: {text: 1}` — after the WABA subscription in §4.2 was added. Three
dashboard Test payloads (`phoneNumberIds: [123456123]`) were logged the same
way. Remaining for the full Phase 0 gate: App Review / Access Verification
on the production app (§6).

---

## 8. Record of ids (fill in)

| Item                                    | Dev                                                         | Prod                              |
| --------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| Business portfolio id                   | `790150064187400` (StoreMink)                               | same                              |
| Business Verification status + date     | Approved (found already verified, 2026-10-08)               | same portfolio                    |
| App ID                                  | `1045672501851798` (StoreMink Dev)                          | `2663634187475548` (StoreMink)    |
| App Secret → Secret Manager name        | `WHATSAPP_APP_SECRET_STAGING`                               | `WHATSAPP_APP_SECRET_PROD`        |
| Verify token → Secret Manager name      | `WHATSAPP_VERIFY_TOKEN_STAGING`                             | `WHATSAPP_VERIFY_TOKEN_PROD`      |
| Embedded Signup Configuration ID        | `1080489094597122` ("ES Config", never expires, 2026-10-11) |                                   |
| Test number: phone number id / WABA id  | `1280649011808874` / `2323545385144849` (+1 555 652-2797)   |                                   |
| System user token → Secret Manager      | `WHATSAPP_SYSTEM_USER_TOKEN_STAGING`                        | `WHATSAPP_SYSTEM_USER_TOKEN_PROD` |
| Webhook verified (date)                 | 2026-10-08 13:06 UTC                                        |                                   |
| App Review: submitted / granted (dates) | —                                                           |                                   |
| Access Verification granted (date)      | —                                                           |                                   |
| Smoke test passed (date, message id)    | 2026-10-08 (send 19:20 IST, inbound logged 14:10:26 UTC)    | —                                 |

---

## 9. Sources

- Meta — [Get started for Tech Providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- Meta — [App Review for solution providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)
- Meta — [Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/)
- Meta — [Create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint)
- Meta — [Graph API webhooks: getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started) (signature header format)
