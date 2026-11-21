#!/usr/bin/env node
// One TEST-MODE debit against a registered Razorpay mandate, sent exactly as
// the renewal job sends it (lib/billing/gateway.ts: an order, then
// POST /payments/create/recurring). It exists to answer one question after
// Razorpay changes something on the account: "does the renewal debit work?"
//
// ★ It refuses anything but an `rzp_test_` key, so no real money can move.
// ★ It reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from the environment, or
//   from the env file named with --env (default .env). Nothing is written.
//
//   node scripts/autopay-test-debit.mjs --customer cust_... --token token_...
//   node scripts/autopay-test-debit.mjs --customer cust_... --token token_... --amount 600000
//
// The 21 Nov 2026 run registered a card mandate in test mode (ceiling ₹5,000):
// see docs/autopay-verification.md for its customer and token ids and for
// what each answer means.
import { existsSync, readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const envFile = args.env ?? ".env";
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^"|"$/g, "")]),
    )
  : {};
const keyId = process.env.RAZORPAY_KEY_ID ?? fileEnv.RAZORPAY_KEY_ID;
const keySecret =
  process.env.RAZORPAY_KEY_SECRET ?? fileEnv.RAZORPAY_KEY_SECRET;

if (!keyId || !keySecret) {
  console.error("No RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET found.");
  process.exit(2);
}
if (!keyId.startsWith("rzp_test_")) {
  console.error("REFUSING: this is not a Razorpay TEST key. Nothing was sent.");
  process.exit(2);
}
if (!args.customer || !args.token) {
  console.error(
    "Usage: --customer cust_... --token token_... [--amount paise]",
  );
  process.exit(2);
}

const amount = Number(args.amount ?? 20000);
const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

async function call(method, path, body) {
  const res = await fetch("https://api.razorpay.com/v1" + path, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // A non-JSON body: the status is the answer.
  }
  return { status: res.status, json };
}

const key = `autopay-test-${Date.now()}`;
const order = await call("POST", "/orders", {
  amount,
  currency: "INR",
  receipt: key.slice(0, 40),
  notes: { idempotency_key: key, kind: "subscription" },
});
if (order.status !== 200) {
  console.log("Could not create the order:", order.status, order.json?.error);
  process.exit(1);
}

const debit = await call("POST", "/payments/create/recurring", {
  email: args.email ?? "autopay.test.run@example.com",
  contact: args.contact ?? "9311456722",
  amount,
  currency: "INR",
  order_id: order.json.id,
  customer_id: args.customer,
  token: args.token,
  recurring: true,
  description: "StoreMink renewal (test-mode check)",
  notes: { idempotency_key: key },
});

console.log(
  `Debit of ${amount} paise on ${order.json.id}: HTTP ${debit.status}`,
);
if (debit.status === 200) {
  console.log(
    "  payment:",
    debit.json?.razorpay_payment_id ?? "(none returned)",
  );
  console.log("  status :", debit.json?.status ?? "(absent, read as created)");
} else {
  console.log("  code       :", debit.json?.error?.code);
  console.log("  description:", debit.json?.error?.description);
  if (
    /requested URL was not found/i.test(debit.json?.error?.description ?? "")
  ) {
    console.log(
      "  meaning    : Razorpay has not enabled the Recurring Payments API on this account.",
    );
  }
}

const payments = await call("GET", `/orders/${order.json.id}/payments`);
console.log(
  "Payments Razorpay lists on that order:",
  JSON.stringify(
    (payments.json?.items ?? []).map((p) => ({
      id: p.id,
      status: p.status,
      error_code: p.error_code ?? null,
      error_description: p.error_description ?? null,
    })),
  ),
);
