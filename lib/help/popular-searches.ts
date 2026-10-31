/**
 * One-tap searches offered on the Help home and on an empty or fruitless
 * search. Each one is a real search on the live guides (checked against the
 * published articles when this list changes); `phone` marks the ones a phone
 * shows, since the row has room for three there. Pure and client-safe.
 */
export const POPULAR_HELP_SEARCHES: readonly {
  query: string;
  label: string;
  phone: boolean;
}[] = [
  { query: "custom domain", label: "Custom Domain", phone: true },
  { query: "cash on delivery", label: "Cash on Delivery", phone: true },
  { query: "razorpay", label: "Razorpay", phone: false },
  { query: "GST invoice", label: "GST invoice", phone: true },
  { query: "shipping rates", label: "Shipping rates", phone: false },
];
