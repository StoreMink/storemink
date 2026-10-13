-- Merchant-visible: Channels → WhatsApp → Templates. A merchant can see every
-- template their number holds with Meta's answer, add their own (a text
-- header, a message with placeholders, a footer, quick-reply, link and call
-- buttons, in a chosen language), delete their own, and send an approved one
-- from the inbox once 24 hours have passed since the customer last wrote. A
-- new task, so one new guide beside the order-updates guide; that guide's
-- sentence about the card's count is widened in place to name the page.

INSERT INTO public.help_articles (category_id, slug, title, excerpt, body, status, seo_title, seo_description, position, published_at)
SELECT id,
  'manage-your-whatsapp-templates',
  'Manage your WhatsApp templates',
  'See every WhatsApp template Meta has reviewed for your number, add your own for the inbox, and delete the ones you no longer need.',
  $article$<p>A WhatsApp template is a message Meta has approved in advance. StoreMink registers one for each order update when you connect your number; you can add your own for anything else you want to send a customer after the 24-hour window has closed, such as a delivery delay or a back-in-stock note.</p>
<p>Open <strong>Settings</strong>, choose <strong>Channels</strong>, open the <strong>WhatsApp</strong> card and choose <strong>Manage templates</strong>. The page lists every template your number holds, in every language, with Meta's answer: <strong>Approved</strong>, <strong>In review</strong>, <strong>Rejected</strong> with Meta's reason, or <strong>Paused</strong> and <strong>Disabled</strong> when Meta has stopped it. Choose <strong>Refresh from Meta</strong> to read the latest answer; Meta usually reviews a template within a day.</p>
<h2>Add a template</h2>
<p>Choose <strong>New template</strong>. Give it a title (its name at Meta is filled in for you: lower-case letters, digits and underscores), pick the language and whether it is <strong>Utility</strong> (about a customer's order or account) or <strong>Marketing</strong> (an offer or news). Write the message, using <strong>{{1}}</strong>, <strong>{{2}}</strong> and so on for the parts you will fill in each time you send it: each placeholder gets a short label, which the inbox shows you when you send, and a sample value, which Meta reviews the template with. A header line, a footer line and up to three buttons are optional: a quick reply, a link to a web page, or a phone number to call.</p>
<p>Some rules Meta applies are checked before the template is sent: a message cannot start or end with a placeholder, two placeholders cannot sit next to each other, and placeholders are numbered in the order they appear. A utility template that reads like an advertisement, or a marketing message sent as utility, is usually rejected by Meta; the reason it gives is shown on the page.</p>
<p>Choose <strong>Send to Meta for review</strong>. The template appears as <strong>In review</strong> and becomes <strong>Approved</strong> once Meta answers.</p>
<h2>Send a template from the inbox</h2>
<p>In <strong>Inbox</strong>, once more than 24 hours have passed since a customer last wrote, the message box offers your approved templates. Choose one, fill in each placeholder and send. A quick-reply button comes back to you as the customer's message with the button's words, so you can answer it like any other. Templates that need something filled in at sending time, such as a picture header or a copy-code button, cannot be sent from the inbox and are not offered when you add a template.</p>
<h2>Delete a template</h2>
<p>Choose <strong>Delete</strong> on one of your own templates. Meta forgets it too, and the inbox stops offering it. StoreMink's order-update templates cannot be deleted; to stop one of those messages, switch it off under <strong>Settings</strong>, <strong>Notifications</strong>.</p>
<h2>Who can change them</h2>
<p>Anyone with <strong>Channels: view</strong> can see the templates. Adding, refreshing or deleting one needs <strong>Channels: manage</strong>.</p>$article$,
  'published',
  'Manage your WhatsApp templates',
  'See every WhatsApp template Meta has reviewed for your number, add your own for the inbox, and delete the ones you no longer need.',
  16,
  now()
FROM public.help_categories WHERE slug = 'marketing'
ON CONFLICT (slug) DO NOTHING;

UPDATE public.help_articles
SET body = replace(
  body,
  $old$If the card shows fewer than the full set, choose <strong>Set up templates</strong> to send the rest.$old$,
  $new$If the card shows fewer than the full set, choose <strong>Set up templates</strong> to send the rest. To see every template with Meta's answer, or to add your own, choose <strong>Manage templates</strong> on the card (see <a href="/help/marketing/manage-your-whatsapp-templates">Manage your WhatsApp templates</a>).$new$
)
WHERE slug = 'send-order-updates-on-whatsapp';
