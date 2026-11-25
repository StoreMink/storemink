-- Help: deleting a customer is guarded (25 Nov 2026).
--
-- The dashboard refuses to delete a customer who has orders or store credit,
-- because `orders.customer_id` cascades on delete and the credit ledger has no
-- foreign key: one click used to remove the order history behind a customer.
-- Any other customer can be deleted from their page.
--
-- The customer-data guide said deletion could remove orders and gave no
-- steps. Its warning, its "contact support" section and its limitation
-- section are edited in place; the excerpt and search description follow.
--
-- Content only; no schema changes.

UPDATE public.help_articles SET body = replace(replace(replace(replace(body,
  $old$<p><strong>Important:</strong> Customer deletion is permanent. In the current StoreMink data model it can remove the customer's login and linked records, including account-linked orders, reviews, blog submissions, addresses, and group membership. It cannot be undone from the dashboard.</p>$old$,
  $new$<p><strong>Important:</strong> A customer who has placed an order, or who holds store credit, can't be deleted, because their order history and the credit you owe them are part of your records. Deleting any other customer is permanent: it removes their saved addresses, reviews, comments and group memberships, and their login when nothing else uses it. Blog posts they submitted stay, without an author.</p>$new$),
  $old$<h2>Contact support before deleting</h2>$old$,
  $new$<h2>Before you delete</h2>$new$),
  $old$Contact <strong>support@storemink.com</strong> before deleting when the customer has ordered, received an invoice, paid tax, received a refund, or has any record the business may be required to retain.</p>$old$,
  $new$Contact <strong>support@storemink.com</strong> when a customer with orders or store credit asks for their data to be removed.</p>$new$),
  $old$<h2>Current Help Centre limitation</h2>
<p>Because deletion can cascade into order records, this guide intentionally does not provide click-by-click deletion instructions. Ask StoreMink Support to help assess the account and the safest available action.</p>$old$,
  $new$<h2>Delete a customer</h2>
<p>Open the customer in <strong>Customers</strong>, choose <strong>Delete customer</strong>, then confirm. If the customer has orders or store credit, the reason is shown and nothing is deleted.</p>$new$),
  excerpt = 'Delete a customer safely, why a customer with orders or store credit is kept, and how to protect required order, invoice and tax records.',
  seo_description = 'Delete a StoreMink customer safely, why customers with orders or store credit are kept, safer alternatives, legal retention and privacy requests.',
  updated_at = now()
WHERE slug = 'protect-customer-data-and-understand-deletion-risk' AND status = 'published'
  AND strpos(body, $old$Customer deletion is permanent. In the current StoreMink data model$old$) > 0
  AND strpos(body, $old$<h2>Current Help Centre limitation</h2>$old$) > 0;
