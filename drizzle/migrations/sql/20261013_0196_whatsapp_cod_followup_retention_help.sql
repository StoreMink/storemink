-- Merchant-visible, two guides, each one sentence extended in place:
--   * the order-updates guide: an unanswered cash-on-delivery confirmation
--     gets one reminder after 24 hours (on unless switched off), and a store
--     may switch on cancelling orders nobody confirms within 48 hours, which
--     the order list shows as "Not confirmed on WhatsApp";
--   * the inbox guide: a closed conversation is deleted two years after its
--     last message, with its photos and files.
UPDATE public.help_articles
SET body = replace(
  body,
  $old$Until a customer answers, the order shows <strong>Awaiting confirmation on WhatsApp</strong>.$old$,
  $new$Until a customer answers, the order shows <strong>Awaiting confirmation on WhatsApp</strong>. A customer who has not answered 24 hours later gets the message once more, while the order is still pending; turn off <strong>Remind customers who haven't answered after 24 hours</strong> if you would rather they did not. To cancel orders nobody confirms, turn on <strong>Cancel orders not confirmed within 48 hours</strong>: a pending order still waiting for an answer 48 hours after the message is cancelled, its stock goes back on sale, the customer is told, and the order shows <strong>Not confirmed on WhatsApp</strong>. A customer who taps <strong>Confirm order</strong> after that is told the order was cancelled, and the chat waits for you in <strong>Inbox</strong>.$new$
)
WHERE slug = 'send-order-updates-on-whatsapp';

UPDATE public.help_articles
SET body = replace(
  body,
  $old$A conversation closes when you choose <strong>Close</strong>, and reopens by itself the next time the customer writes.$old$,
  $new$A conversation closes when you choose <strong>Close</strong>, and reopens by itself the next time the customer writes. A closed conversation is deleted two years after its last message, together with any photos and files in it; conversations that are open or waiting for a reply are kept.$new$
)
WHERE slug = 'reply-to-whatsapp-messages';
