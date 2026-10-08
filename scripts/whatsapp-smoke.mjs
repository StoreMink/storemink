#!/usr/bin/env node

// ---------------------------------------------------------------------------
// WhatsApp Cloud API smoke test — Phase 0 of docs/whatsapp-commerce-plan.md.
//
// Sends ONE template message from a phone number to a recipient, using a
// token you paste from Meta's console (the test number's temporary token, or
// a system-user token). It is the "message sent from your app and received
// in the WhatsApp client" that App Review's first video must show, and the
// Phase 0 gate ("a test message sent and received on a sandbox number").
//
// It touches no database and reads no application config: this is a check
// that Meta's side is wired, run before any merchant code exists.
//
//   WHATSAPP_ACCESS_TOKEN=EAAB… WHATSAPP_PHONE_NUMBER_ID=1234567890 \
//     npm run whatsapp:smoke -- --to=+919876543210 --yes
//
//   --template=NAME   defaults to hello_world (Meta ships it on every test
//                     number); your own approved templates work too
//   --lang=CODE       defaults to en_US
//   --dry-run         print the request and send nothing
//
// `--yes` is required to send: Meta bills a template message outside a
// customer-service window, and a stray run must not cost money silently.
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const arg = (name) =>
  process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION?.trim() || "v25.0";
const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
const to = arg("to")?.replace(/[^\d]/g, "");
const template = arg("template") || "hello_world";
const lang = arg("lang") || "en_US";
const dryRun = args.has("--dry-run");

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

if (!token) fail("WHATSAPP_ACCESS_TOKEN is required (never commit it).");
if (!phoneNumberId) fail("WHATSAPP_PHONE_NUMBER_ID is required.");
if (!to || to.length < 10)
  fail("--to=<E.164 number> is required, e.g. --to=+919876543210");
if (!dryRun && !args.has("--yes")) {
  fail(
    "Refusing to send without --yes (a template message is billable). Use --dry-run to inspect.",
  );
}

const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
const body = {
  messaging_product: "whatsapp",
  to,
  type: "template",
  template: { name: template, language: { code: lang } },
};

process.stdout.write(`POST ${url}\n${JSON.stringify(body, null, 2)}\n`);
if (dryRun) {
  process.stdout.write("dry run — nothing sent\n");
  process.exit(0);
}

const started = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});
const text = await res.text();
const ms = Date.now() - started;

process.stdout.write(
  `\n${res.status} ${res.statusText} in ${ms} ms\n${text}\n`,
);

if (!res.ok) {
  // Meta's error JSON names the cause (code 131030 = recipient not in the test
  // number's allowlist, 190 = token expired, 100 = bad template/language).
  process.exit(1);
}
process.stdout.write(
  "\nAccepted. The message id above should reach the handset; a reply to it arrives at /api/webhooks/whatsapp as a `whatsapp webhook received` log line.\n",
);
