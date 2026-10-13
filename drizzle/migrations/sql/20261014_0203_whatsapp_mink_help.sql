-- Merchant-visible: Inbox → Automatic replies gains "Mink AI answers", with
-- two ways of helping, and the inbox thread gains Mink's draft card. The
-- automatic-replies guide gets one section for the new control, placed
-- before "Who can change them" like the menu section was; the inbox guide's
-- reply paragraph gains one sentence about the draft card, extended in place.

UPDATE public.help_articles
SET body = replace(
  body,
  $old$<h2>Who can change them</h2>$old$,
  $new$<h2>Answers from Mink AI</h2>
<p>With <strong>Mink AI answers</strong> on, Mink reads each customer's question against your store's own facts: the orders placed with the number they are writing from, the products they name with the price and stock shown on your store, delivery to a PIN code they mention, the offers running now, your published policies and your business hours. Choose one of two ways for it to help.</p>
<p><strong>Answers customers</strong> lets Mink reply on its own when the answer is in those facts, for example a price, whether a size is in stock, when you open, what your return policy says, or where their order is. Anything the facts do not cover waits for you in <strong>Needs reply</strong> with Mink's suggested reply attached. A complaint, a refund, a return of goods they have, a cancellation, a change to an address or an order, a payment problem, or a request to talk to a person always waits for you: Mink cannot do any of those, and it never tries. Mink replies in the language the customer wrote in, and if asked whether it is a person, it says it is the shop's automatic assistant and that a person can take over.</p>
<p><strong>Drafts replies for you</strong> never sends anything. Every message waits for you in <strong>Needs reply</strong> as before, with Mink's suggested reply shown above the message box. Send it as it is, change it first, or discard it and write your own.</p>
<p>Each reply Mink sends, or that you send from one of its drafts, uses 1 Mink credit from the same credits as the Mink in your dashboard; a draft nobody sends is free. When your credits run out, Mink stops answering and every message waits for you. Your credits are under <strong>Plans &amp; Billing</strong>. Mink is off until you turn it on, so a store that never chose sends exactly what it sent before.</p>
<h2>Who can change them</h2>$new$
)
WHERE slug = 'set-up-whatsapp-automatic-replies';

UPDATE public.help_articles
SET body = replace(
  body,
  $old$set up a welcome message, an away message and order status replies under <a href="/help/marketing/set-up-whatsapp-automatic-replies">Automatic replies</a>.$old$,
  $new$set up a welcome message, an away message, order status replies and answers from Mink AI under <a href="/help/marketing/set-up-whatsapp-automatic-replies">Automatic replies</a>. When Mink AI drafted a reply for a conversation, the draft appears above the message box with what it drew on: check it, change anything you like, and press <strong>Send</strong>, or <strong>Discard</strong> it. Sending a draft uses 1 Mink credit; writing your own reply does not.$new$
)
WHERE slug = 'reply-to-whatsapp-messages';
