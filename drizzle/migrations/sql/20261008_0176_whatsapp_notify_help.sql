-- WhatsApp order updates are a merchant-visible flow from this slice: a
-- merchant connects a number, chooses which notifications go out on it, and
-- shoppers tick a box at checkout. One task guide, beside the SMS guides in
-- Marketing & communications; nothing is appended to an existing article.
INSERT INTO public.help_articles
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT id,
  'send-order-updates-on-whatsapp',
  'Send order updates on WhatsApp',
  'Connect your own WhatsApp number, let Meta approve the message wording, choose which updates go out, and read what was delivered.',
  $article$<p>Your store can send order updates from your own WhatsApp number: order received, ready to collect, shipped, delivered, cancelled, refunded, and a few more. Customers reply to the same number. Meta charges your account for business-initiated messages; StoreMink adds no fee of its own.</p>
<h2>Connect your number</h2>
<ol><li>Open <strong>Settings → Channels</strong> and choose <strong>WhatsApp</strong>. WhatsApp is included from the Basic plan.</li><li>Answer whether the number is already on the WhatsApp Business app on your phone. If it is, StoreMink keeps it working there as well, and you can still reply from your phone.</li><li>Choose <strong>Connect with Meta</strong>, sign in to Facebook, pick or create your business, and confirm the number with the code Meta sends.</li><li>In WhatsApp Manager, add a payment method under <strong>Billing &amp; payments</strong>. Without one, Meta does not send business-initiated messages.</li></ol>
<p>Connecting also sends StoreMink's message templates to Meta for review. The WhatsApp card shows how many are approved; Meta usually answers within a day. If the card shows fewer than the full set, choose <strong>Set up templates</strong> to send the rest.</p>
<h2>Choose which updates go out</h2>
<p>Open <strong>Settings → Notifications</strong>, pick a notification, and tick <strong>WhatsApp</strong> for customers, your team, or both. The WhatsApp tab shows the exact wording Meta approved and whether that template is approved, still in review, or paused. A message sends only once its template is approved, so a notification switched on during review starts working when Meta approves it without any further action from you.</p>
<p>Team updates go to the mobile number on each team member's account. Customer updates go only to customers who agreed to them.</p>
<h2>How customers agree</h2>
<p>Once your number is connected, checkout shows two boxes: <strong>order updates on WhatsApp</strong>, ticked by default, and <strong>offers and news on WhatsApp</strong>, which the customer must tick themselves. StoreMink records the wording they agreed to and when. A customer who leaves the first box unticked receives no WhatsApp updates for that order.</p>
<h2>If a customer has both SMS and WhatsApp</h2>
<p>A customer who can receive an update on both channels gets it once, on WhatsApp. SMS is used when WhatsApp cannot deliver — for example when the customer did not opt in or the template is not yet approved. You can change this under <strong>Settings → Channels → WhatsApp → Settings</strong>: SMS first, or both.</p>
<h2>Read what was delivered</h2>
<p>Open <strong>Logs → WhatsApp logs</strong>. Each row shows the message, and whether it was sent, delivered, or read, with the time. A failed row carries Meta's reason, such as a number that is not on WhatsApp. Failed messages also appear under <strong>Logs → Failures</strong>.</p>
<h2>Pause, refresh or disconnect</h2>
<p><strong>Pause</strong> stops new messages while keeping the connection. <strong>Refresh from Meta</strong> re-reads your daily sending limit, quality rating, display name review, and template approvals. <strong>Disconnect</strong> removes the connection from StoreMink; your Meta account and number are untouched, and you can reconnect at any time.</p>$article$,
  'published',
  'Send order updates on WhatsApp from your StoreMink store',
  'Connect your own WhatsApp number, choose which order updates customers and staff receive, and read delivery results.',
  13, now()
FROM public.help_categories WHERE slug = 'marketing'
ON CONFLICT (slug) DO NOTHING;
