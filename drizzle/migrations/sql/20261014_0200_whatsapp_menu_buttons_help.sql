-- Merchant-visible: Inbox → Automatic replies gains menu buttons, up to three
-- reply buttons sent with the welcome message and whenever a customer asks
-- for the menu. The automatic-replies guide gets one section for the new
-- control, placed before "Who can change them" so the reader meets it with
-- the other replies; nothing above it changes.

UPDATE public.help_articles
SET body = replace(
  body,
  $old$<h2>Who can change them</h2>$old$,
  $new$<h2>Menu buttons</h2>
<p>With <strong>Menu buttons</strong> on, your welcome message goes out with up to three buttons under it, and a customer who types "menu" or "options" gets the buttons again. WhatsApp allows three buttons on a message, and each label can be up to 20 characters.</p>
<p>Each button does one of three things when the customer taps it. <strong>Check my order</strong> answers with the status of their recent orders, exactly as Order status does, and waits for you if no order matches. <strong>Talk to a person</strong> sends a short acknowledgement (yours, or "Sure. Someone from our team will reply here shortly.") and puts the conversation in <strong>Needs reply</strong> with the bell. <strong>Send a message</strong> sends the message you wrote, for example your opening hours or your address.</p>
<p>The buttons are sent with the welcome message, so a conversation that has already had its welcome gets them only when the customer asks for the menu. If you turn the welcome message off, the buttons go out under "How can we help? Choose an option:" when a customer asks for them. The thread in Inbox shows the buttons under the message as the customer saw them, and a tap shows as the button's label with a "Tapped a button" mark.</p>
<h2>Who can change them</h2>$new$
)
WHERE slug = 'set-up-whatsapp-automatic-replies';
