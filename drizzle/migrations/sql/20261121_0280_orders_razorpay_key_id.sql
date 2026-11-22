-- Which connected Razorpay account an online order was created on
-- (21 Nov 2026).
--
-- An order kept its gateway order id and, once paid, its payment id, but
-- nothing said which of the store's keys made it. A store can replace its
-- keys or connect another Razorpay account, so when a later read of an order
-- waiting for payment was refused there was no telling "the keys changed
-- since this order was placed" from "Razorpay is refusing the keys that made
-- it". `orders.razorpay_key_id` records the PUBLIC key id (never a secret)
-- when checkout pins the gateway order to the order.
--
-- Nullable with no default and no backfill: orders placed before this carry
-- nothing, which is the truth, and adding a nullable column rewrites no rows.
-- Expand only: the revision being replaced never names the column, and the
-- new one pins the gateway order id alone if this has not run yet.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS razorpay_key_id text;
