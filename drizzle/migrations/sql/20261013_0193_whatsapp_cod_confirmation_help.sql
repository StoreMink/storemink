-- Merchant-visible: a store can now ask cash-on-delivery customers to confirm
-- or cancel their order from WhatsApp buttons, and the order list shows the
-- answer. One section in the existing order-updates guide, placed before the
-- SMS-or-WhatsApp section it sits beside; the guide is short (six sections),
-- and this is a task a merchant sets up, not a changelog entry.
UPDATE public.help_articles
SET body = replace(
  body,
  $old$<h2>If a customer has both SMS and WhatsApp</h2>$old$,
  $new$<h2>Ask cash-on-delivery customers to confirm</h2>
<p>Cash-on-delivery orders can be confirmed before you pack them. Under <strong>Settings → Channels → WhatsApp → Settings</strong>, turn on <strong>Ask cash-on-delivery customers to confirm on WhatsApp</strong>. A customer who places a cash-on-delivery order for delivery on your website then gets a WhatsApp message with two buttons, <strong>Confirm order</strong> and <strong>Cancel order</strong>, instead of the usual order message. Collections and prepaid orders are not asked.</p>
<ul><li><strong>Confirm order</strong> marks the order <strong>Confirmed on WhatsApp</strong> in <strong>Orders</strong>, so you know it is worth packing.</li><li><strong>Cancel order</strong> cancels it straight away if it has not shipped: the stock goes back on sale, any store credit the customer used goes back to their balance, and you and the customer are told. Nothing was paid, so there is nothing to refund.</li><li>A customer who taps <strong>Cancel order</strong> after the order has shipped is told it can't be cancelled there, and the chat waits for you in <strong>Inbox</strong>.</li></ul>
<p>The customer gets a reply on WhatsApp after either tap, and the whole exchange appears in <strong>Inbox</strong>. Until a customer answers, the order shows <strong>Awaiting confirmation on WhatsApp</strong>. This message needs its own approval from Meta; until it is approved, customers get the usual order message, and the WhatsApp tab of the <strong>Order placed</strong> notification shows where the review stands.</p>
<h2>If a customer has both SMS and WhatsApp</h2>$new$
)
WHERE slug = 'send-order-updates-on-whatsapp';
