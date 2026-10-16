-- The inbox is a merchant-visible flow from this slice: staff read and answer
-- WhatsApp messages in the dashboard, customers can start a chat from the
-- storefront, and a shopper can change their WhatsApp choices on their
-- account page. One task guide beside the order-updates guide; the one
-- sentence in that guide which is no longer the whole truth is edited in
-- place rather than joined by a new section.
INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT id,
  'reply-to-whatsapp-messages',
  'Reply to WhatsApp messages',
  'Read and answer customer messages in Inbox, reply from your phone too, let customers start a chat from your store, and understand STOP.',
  $article$<p>Once your WhatsApp number is connected, every message a customer sends to it arrives in <strong>Inbox</strong>, whether they replied to an order update, scanned your QR code, or tapped the chat button on your store. Replying to a customer who messaged you first costs nothing on Meta's side.</p>
<h2>Open the inbox</h2>
<p><strong>Inbox</strong> appears in the sidebar as soon as a WhatsApp number is connected. The number beside it is how many conversations are waiting on a reply from you; it goes away as you answer. Use the <strong>Needs reply</strong>, <strong>Open</strong> and <strong>Closed</strong> tabs to work through them, and search by name or phone number. A conversation closes when you choose <strong>Close</strong>, and reopens by itself the next time the customer writes.</p>
<h2>Reply</h2>
<p>Open a conversation and type your reply. You can write freely for 24 hours after the customer's last message; the countdown is shown above the reply box. After that, WhatsApp allows only an approved message template until the customer writes again. The reply box then offers your approved templates, and you fill in the details they need. Any message from the customer restarts the 24 hours.</p>
<p>Beside each conversation you can see the customer's recent orders, store credit and whether they have agreed to order updates and offers on WhatsApp, so you can answer without leaving the inbox.</p>
<h2>Reply from your phone as well</h2>
<p>If you connected a number that is also on the WhatsApp Business app, you can keep answering from your phone. Messages you send there appear in Inbox too, marked as sent from your phone, so your team always sees the whole conversation.</p>
<h2>Photos, documents and voice notes</h2>
<p>Anything a customer sends is shown in the conversation and kept with it. Replies from the dashboard are text; to send a photo or file, reply from your phone.</p>
<h2>When a customer writes STOP</h2>
<p>A customer who replies STOP, unsubscribe, or the same in Hindi stops receiving offers and news from your number. Order updates continue, because they are about that customer's own orders. Customers can also change both choices under <strong>My account</strong> on your store at any time.</p>
<h2>Let customers start a chat</h2>
<p>Open <strong>Settings → Channels → WhatsApp</strong>. The card shows a QR code and a link for your number: print the code for your counter or packaging, or share the link. Under <strong>Settings</strong> in the same card, the <strong>chat button</strong> switch shows a WhatsApp button on every page of your store that opens a chat with your number; switch it off if you prefer customers to use the enquiry form.</p>
<h2>Who can see the inbox</h2>
<p>Inbox is its own permission. Under <strong>Settings → Staff → Roles</strong>, give a role <strong>Inbox: view</strong> to read conversations and <strong>Inbox: manage</strong> to reply and close them.</p>$article$,
  'published',
  'Reply to WhatsApp messages from your StoreMink inbox',
  'Answer customer WhatsApp messages in the dashboard, keep replying from your phone, add a chat button and QR code, and handle STOP.',
  14, now()
FROM public.help_categories WHERE slug = 'marketing'
ON CONFLICT (slug) DO NOTHING;

-- The order-updates guide said where consent is given and stopped there. The
-- sentence is edited in place; a merchant reading it now learns the two other
-- facts that are true today, without a section announcing them.
UPDATE public.help_articles
SET body = replace(
  body,
  $old$A customer who leaves the first box unticked receives no WhatsApp updates for that order.$old$,
  $new$A customer who leaves the first box unticked receives no WhatsApp updates for that order. Customers can change both choices later under <strong>My account</strong> on your store, and their replies to any update arrive in <strong>Inbox</strong>.$new$
)
WHERE slug = 'send-order-updates-on-whatsapp';
