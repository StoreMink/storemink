-- Merchant-visible: Inbox → Automatic replies lets a store send a welcome
-- message, an away message outside its business hours, and an automatic
-- answer to "where is my order?". A new task, so one new guide beside the
-- inbox guide; the inbox guide's Reply section gains one sentence pointing to
-- it, extended in place rather than given a section of its own.
INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT id,
  'set-up-whatsapp-automatic-replies',
  'Set up automatic replies on WhatsApp',
  'Send a welcome message, an away message outside your business hours, and answer "where is my order?" automatically.',
  $article$<p>Automatic replies answer customers on your WhatsApp number when nobody on your team is free to. Open <strong>Inbox</strong> and select <strong>Automatic replies</strong>. Each reply is off until you turn it on, and you can change the words to suit your shop. Automatic replies are sent only while your WhatsApp number is connected and switched on.</p>
<h2>Welcome message</h2>
<p>A customer who messages you for the first time, or for the first time in 14 days, gets your welcome message. The conversation still waits for you in <strong>Needs reply</strong>, because the customer has not heard from a person yet.</p>
<h2>Away message and business hours</h2>
<p>Set the hours you answer messages on each day of the week: <strong>Open</strong> with an opening and closing time, <strong>Open all day</strong>, or <strong>Closed</strong>. A closing time earlier than the opening time runs into the next day, for example 18:00 to 02:00. The times are in your business time zone, which you can change under <strong>Settings</strong>.</p>
<p>A customer who messages you outside those hours gets your away message once, and does not get it again until you have been open since. It is not sent if someone on your team replied to that customer in the last two hours. To be away for a holiday, set those days to <strong>Closed</strong> and say in the away message when you are back.</p>
<p>When a new customer writes outside your hours, the welcome message and the away message arrive together as one message.</p>
<h2>Order status</h2>
<p>With <strong>Order status</strong> on, a customer who asks where their order is gets an answer straight away: the order number, the day they placed it, where it is, and the courier's tracking link once it has shipped. Customers can ask in English or Hindi, for example "where is my order" or "mera order kab aayega".</p>
<p>Only orders placed with the number the customer is messaging from are shown: orders on their account with that phone number, and orders with that number as the delivery phone. Nothing is said about any other order. If no recent order matches, or a delivery has a problem such as a failed delivery attempt, the customer is told that someone will reply, and the conversation waits for you in <strong>Needs reply</strong>. A message that also mentions a problem, such as "my order was not delivered" or "cancel my order", always waits for you.</p>
<h2>Who can change them</h2>
<p>Anyone with <strong>Inbox: view</strong> can see these settings. Changing them needs <strong>Inbox: manage</strong>.</p>$article$,
  'published',
  'Set up WhatsApp automatic replies in StoreMink',
  'Send a WhatsApp welcome message and an away message outside business hours, and answer order status questions automatically.',
  15, now()
FROM public.help_categories WHERE slug = 'marketing'
ON CONFLICT (slug) DO NOTHING;

UPDATE public.help_articles
SET body = replace(
  body,
  $old$Any message from the customer restarts the 24 hours.$old$,
  $new$Any message from the customer restarts the 24 hours. To answer customers when nobody is free, set up a welcome message, an away message and order status replies under <a href="/help/marketing/set-up-whatsapp-automatic-replies">Automatic replies</a>.$new$
)
WHERE slug = 'reply-to-whatsapp-messages';
