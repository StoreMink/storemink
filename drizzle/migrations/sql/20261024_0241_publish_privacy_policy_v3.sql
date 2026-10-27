-- Publish Privacy Policy v3 with this release (owner, 24 Oct 2026: a lawyer
-- reviewed lib/legal/content.ts's v3 and approved it exactly as written, and it
-- goes live with this release). Release checklist step 5, option (a): the deploy
-- publishes it on staging and then production, so nobody handles a database
-- password.
--
-- ★★ THIS IS publishLegalVersion (lib/legal/store.ts) IN SQL, in one
-- transaction: retire the current privacy row (is_current false, by its id; the
-- guard trigger allows exactly that and moves updated_at), then insert version
-- 3 as current with the kind, version, title, body, checksum, is_current,
-- published_at and created_by it writes. created_by is 'script', what
-- scripts/publish-legal.ts passes (it writes no operator id), and effective_at
-- is now(), the column default it relies on. The retire comes first, or
-- legal_documents_current_key (one current row per kind) refuses the insert.
--
-- ★ GUARDED, so it is safe everywhere:
--   - a current privacy row at version 3 or later: nothing to do
--     (storemink_local has had v3 since 13 Oct, and a later v4 must never be
--     undone by an old migration);
--   - a privacy v3 row that is not current: an impossible state (v3 retired
--     with no later version in force). Stop the deploy rather than guess;
--   - otherwise (v1 or v2 current, or none): publish v3.
-- Terms and Acceptable Use are never named: their v2 still needs the company's
-- registered name and address and a governing-law clause, and stays
-- unpublished.
--
-- ★ THE BODY IS EXACTLY content.ts's PRIVACY_BODY, which is already trimmed,
-- in a dollar quote whose tag cannot occur in it (the body holds no dollar
-- sign). The checksum literal is checksumBody(body), the sha256 of the trimmed
-- body that lib/legal and scripts/publish-legal.ts compare against. The block
-- recomputes it before it writes anything and refuses on a mismatch, and
-- lib/legal/privacy-v3-migration.test.ts holds this file to content.ts.
--
-- ★ WHO SEES IT, AND WHEN. From the commit, /legal/privacy serves v3 and
-- signup asks for v3. Every dashboard account that has not accepted v3 is sent
-- to /auth/policy-update on its next dashboard visit: the re-acceptance gate
-- (outstandingDocs) reads the current versions through a 60 s cache, which
-- this migration cannot clear, so on a revision already running that is within
-- a minute.
--
-- Data only, and idempotent: a second run, or a database that already has v3,
-- changes nothing.
DO $$
DECLARE
  v_body CONSTANT text := $privacy_v3_body$<p><em>Version 3</em></p>
<h2>1. Two different roles</h2>
<p>This policy covers data StoreMink holds as a <strong>controller</strong>: your merchant account, your billing, your staff accounts, and your use of our dashboard.</p>
<p>For the personal data your <strong>customers</strong> give to <strong>your</strong> store (names, addresses, order history), the merchant is the controller and StoreMink is a <strong>processor</strong> acting on their instructions. If you shopped at a store built on StoreMink and want your data changed or removed, contact that store first; we will assist them.</p>
<h2>2. What we collect</h2>
<p><strong>Account data</strong>: name, email address, phone number, password (hashed; we never see it in the clear), and the business location you give at signup.</p>
<p><strong>Staff data</strong>: for people you invite to the dashboard or a register, their name, email, role, the locations you assign them, and their register credential (stored hashed).</p>
<p><strong>Store data</strong>: what you create in the product: products, pages, orders, customers, and settings.</p>
<p><strong>Usage and technical data</strong>: IP address, browser and device information, and logs of requests, errors, emails and messages sent. Some of this is security evidence rather than analytics; for example, we record the IP and browser used when someone accepts our Terms, and when a register device is authorised.</p>
<p><strong>AI interactions</strong>: the questions you put to our AI features, the context we assembled to answer them, the output returned, and any rating or issue report you send us about an answer. See clause 5.</p>
<p><strong>Payment data</strong>: we do <strong>not</strong> store card numbers. Payments are handled by payment providers; we store only identifiers, amounts and status returned by them.</p>
<h2>3. Why we use it</h2>
<p>To provide and secure the service; to bill you; to send transactional messages you need (order alerts, security notices, billing); to run the features you switch on, including AI features; to support you when you ask; to detect abuse and fraud; and to meet legal obligations.</p>
<p>We do not sell personal data, and we do not use your data or your customers' data to train our own models.</p>
<h2>4. Who we share it with</h2>
<p>Providers who process data on our behalf under contract, so that the service works. Currently:</p>
<ul>
<li><strong>Google Cloud</strong>: hosting, database and file storage.</li>
<li><strong>Google Identity Platform</strong>: accounts, sign-in, and the SMS one-time codes used to verify a phone number.</li>
<li><strong>Google Vertex AI and the Gemini API</strong>: our AI features. See clause 5 for what reaches them.</li>
<li><strong>Resend</strong>: email delivery, including delivery outcomes such as bounces and complaints.</li>
<li><strong>Razorpay</strong>: our own subscription and credit payments.</li>
<li><strong>Google Maps</strong> and <strong>BigDataCloud</strong>: turning a location or coordinates into an address, when someone asks us to. The BigDataCloud lookup is made by the browser at the moment a merchant or a shopper chooses to use it.</li>
<li><strong>Google Search Console</strong>: search performance for launched stores and their sitemaps.</li>
</ul>
<p>Where <strong>you</strong> connect an account of your own (a payment gateway, a logistics provider such as <strong>Shiprocket</strong>, an SMS provider such as <strong>Twilio</strong>, or an analytics or advertising tag), our software sends data to it <strong>on your instructions</strong>. Those providers act for you, under your agreement with them, and this policy does not govern what they do with it. Shipping a parcel sends your customer's name, address and phone to the carrier; sending an SMS sends their number and the message.</p>
<p>We may also disclose data where required by law, or to protect the rights and safety of our users or the public.</p>
<h2>5. AI features and your data</h2>
<p>When you use an AI feature we send the model only what it needs for that request: your store profile and brand settings, and the specific catalogue, sales, inventory, order or Website Builder content the request is about. Where an answer involves orders or customers, direct contact details are minimised or masked before they are sent.</p>
<p>Our provider processes this to return an answer. It is bound by contract, and we do not permit it or ourselves to use your data to train general-purpose models. Their contractual terms, not this policy, govern what they may do; if that changes materially we will say so here.</p>
<p>We keep your AI conversations so you can reopen them, and to investigate a problem you report. They are visible only to your own account, are retained for a limited period and are then deleted. Where our support team needs to look at a reported answer, the detail we store for that purpose is reduced first.</p>
<p>Public Help Centre answers work the same way: the question you type and the published guides we retrieved are sent to the model. Do not put passwords, card numbers or anyone else's personal details into an AI prompt.</p>
<h2>6. Where it is held, and for how long</h2>
<p>Data is hosted on Google Cloud infrastructure. Some providers may process data outside your country; where they do, we rely on the safeguards those providers offer.</p>
<p>We keep data for as long as your account is active, then for a period afterwards where we need it for legal, tax or dispute-resolution reasons. Operational records are pruned on a rolling basis: activity records after one year, notification, email and message records after ninety days, AI conversations after ninety days, and raw storefront analytics events after fourteen days once they have been aggregated. Search performance history is kept longer because the source only reports a limited window.</p>
<h2>7. Your rights</h2>
<p>Depending on where you live, you may ask us to give you a copy of your data, correct it, delete it, restrict how we use it, or object to a use. Write to <a href="mailto:support@storemink.com">support@storemink.com</a> and we will respond within the period the applicable law allows.</p>
<p>You can export most of your store data yourself from the dashboard at any time.</p>
<p>Deleting a store is permanent. It removes the store's records, its uploaded media, and the sign-in accounts that existed only for that store; an account that is also used elsewhere is kept. Some data cannot be deleted on request; a record that you accepted our Terms, or an invoice we must keep for tax, are examples. If you need an account or its order history removed, contact us rather than deleting piecemeal, so that linked records are handled correctly.</p>
<h2>8. If you shopped at a store built on StoreMink</h2>
<p>The merchant decides what to collect and why; we process it for them. Ask them first: they can change or remove your details, and we will help them do it.</p>
<p>A merchant may add their own analytics or advertising tags to their storefront. Those send data to the merchant's own accounts, not ours, and only after you allow that category on their site. You can withdraw that choice on the same site at any time. First-party measurement, where the merchant has switched it on, uses a key we rotate daily and does not store an identifier in your browser. It records the pages you view and the shopping steps you take, the type of device you use (desktop, mobile or tablet), the website or tagged campaign link that brought you, and your approximate location (country, state and city) as reported by your network. We do not keep your IP address, your browser details or the full address of the page that referred you.</p>
<h2>9. Security</h2>
<p>We use encryption in transit, tenant isolation enforced in the database, hashed credentials, scoped access for staff you invite, and least-privilege access internally. Credentials you give us for a provider you connect are encrypted before storage and are never shown back to you.</p>
<p>No system is perfectly secure; if a breach affects your data we will notify you as the law requires.</p>
<h2>10. Children</h2>
<p>The service is not intended for anyone under 18, and we do not knowingly collect their data.</p>
<h2>11. Changes and contact</h2>
<p>We publish each version of this policy with a version number and effective date. Questions or requests: <a href="mailto:support@storemink.com">support@storemink.com</a>.</p>$privacy_v3_body$;
  v_checksum CONSTANT text := 'e81f10e36adcd086b95de13f48f624af7fd74c33d76675100d295d5663922987';
  v_title CONSTANT text := 'Privacy Policy';
  v_current_id uuid;
  v_current_version integer;
BEGIN
  IF encode(sha256(convert_to(v_body, 'UTF8')), 'hex') <> v_checksum THEN
    RAISE EXCEPTION 'Privacy Policy v3: the body does not match its checksum. Nothing was published.';
  END IF;

  SELECT id, version INTO v_current_id, v_current_version
    FROM public.legal_documents
   WHERE kind = 'privacy' AND is_current;

  IF v_current_version >= 3 THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.legal_documents WHERE kind = 'privacy' AND version = 3
  ) THEN
    RAISE EXCEPTION 'Privacy Policy v3 is in legal_documents but is not the current version (current: %). Nothing was changed. Check legal_documents by hand before deploying again.',
      coalesce('v' || v_current_version::text, 'none');
  END IF;

  IF v_current_id IS NOT NULL THEN
    UPDATE public.legal_documents SET is_current = false WHERE id = v_current_id;
  END IF;

  INSERT INTO public.legal_documents
    (kind, version, title, body, checksum, is_current, effective_at, published_at, created_by)
  VALUES
    ('privacy', 3, v_title, v_body, v_checksum, true, now(), now(), 'script');
END
$$;
