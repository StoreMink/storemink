// ---------------------------------------------------------------------------
// StoreMink's own policies.
//
// REVIEWED AND APPROVED. Terms of Service v2, Privacy Policy v4 and
// Acceptable Use Policy v2 below were reviewed by a lawyer and approved for
// publication exactly as written (owner, 26 Oct 2026). Migration
// 20261026_0255_publish_legal_terms_v2_privacy_v4_aup_v2
// publishes all three together, so every merchant accepts once. They cover
// the risks this product structurally has: platform-not-seller, funds
// settling directly to merchants, the merchant as Data Fiduciary with
// StoreMink as its Data Processor, AI output the merchant approves and relies
// on, and liability capped at fees. Any change to the wording is a new
// version, and it needs the same review.
//
// The two clauses version 1 of the Terms left open are settled: the
// contracting party is STOREMINK LLP (registered office published as
// "Faridkot, Punjab, India" only, on the owner's instruction), and the courts
// at Faridkot, Punjab have exclusive jurisdiction.
//
// ⚠ NEVER put a bracketed placeholder in a body below. These strings are
// published verbatim into an immutable table; `legal.test.ts` fails the build
// if one appears, because a placeholder that reaches production is a policy
// that says nothing at the exact moment it is relied on.
//
// WHY THE CONTENT LIVES IN CODE: it is reviewable in a diff, version-controlled
// alongside the product it describes, and seeded into legal_documents by an
// idempotent publish (ensureLegalSeeded in lib/legal/store.ts, which
// scripts/seed-legal.ts runs) the same way ensureHomepage() seeds a
// store_pages row. Once published, the DB row is the source of truth and is
// immutable: editing this file does not change what anyone already accepted.
// ---------------------------------------------------------------------------

export interface LegalContent {
  kind: string;
  title: string;
  version: number;
  body: string;
}

const COMPANY = "StoreMink";

/**
 * Who StoreMink is in law, in the words all three policies use (owner,
 * 25 Oct 2026: the registered office is published as the city only).
 */
const ENTITY =
  "STOREMINK LLP, a limited liability partnership registered with limited liability under the Limited Liability Partnership Act, 2008 (LLPIN ADC-5432), incorporated on 21 September 2026, with its registered office at Faridkot, Punjab, India";

/** House style: a section with a heading and paragraphs. */
function section(heading: string, ...paras: string[]): string {
  return `<h2>${heading}</h2>\n${paras.map((p) => `<p>${p}</p>`).join("\n")}`;
}

/** A section whose last block is a list, used where prose would hide items. */
function listSection(
  heading: string,
  intro: string,
  items: string[],
  ...after: string[]
): string {
  const list = items.map((i) => `<li>${i}</li>`).join("\n");
  return [
    `<h2>${heading}</h2>`,
    `<p>${intro}</p>`,
    `<ul>\n${list}\n</ul>`,
    ...after.map((p) => `<p>${p}</p>`),
  ].join("\n");
}

// ── Terms of Service ────────────────────────────────────────────────────────
const TERMS_BODY = [
  `<p><em>Version 2</em></p>`,
  `<p>These Terms are a contract between you and ${ENTITY}. In these Terms, "${COMPANY}", "we", "us" and "our" mean STOREMINK LLP.</p>`,
  `<p>These Terms are available in English and, on request at <a href="mailto:support@storemink.com">support@storemink.com</a>, in any language listed in the Eighth Schedule to the Constitution of India.</p>`,

  section(
    "1. Who we are, and what this covers",
    `${COMPANY} provides software that lets you create and run an online store, sell in person, and manage the work behind both.`,
    `You agree to these Terms, our Privacy Policy and our Acceptable Use Policy when you tick the box at signup and create your account. If you agree for a company or another business, you confirm that you may bind it, and "you" means that business.`,
    `You must be at least 18 and use ${COMPANY} for your business. Everyone you let use your dashboard or your POS must also be at least 18.`,
    `People you invite to your dashboard are asked to accept these Terms before they can use it. Staff who only use POS are not asked, so before they set up their POS login you must give them a link to our Privacy Policy, and you must make sure they follow these Terms. You are responsible for everyone you give access to; they act for you, not for us.`,
  ),

  section(
    "2. We are a platform, not the seller",
    `${COMPANY} provides tools. <strong>You are the seller of every product listed in your store.</strong> You alone are responsible for your products, their description, pricing, legality, safety, quality, packaging, delivery, warranties, returns and after-sales support.`,
    `${COMPANY} is not a party to any contract between you and your customers. Any dispute about goods, delivery or refunds is between you and your customer. We may, but are not obliged to, provide information to help resolve such a dispute.`,
    `This applies to everything published through your account however it was produced, <strong>including text, images and code produced with our AI features</strong>. No person at ${COMPANY} reviews what our AI features make before it reaches your customers. Mink AI has automatic safeguards meant to stop it making harmful or unlawful material and to catch some mistakes, but they can miss things and do not replace your own check.`,
    `We host what you, your staff and your customers put on your store. We do not choose or edit it, but we may remove it or block access to it as our Acceptable Use Policy describes, or when the law, a court or government order, or a valid complaint requires.`,
  ),

  section(
    "3. Payments settle to you, not to us",
    `Where you connect your own payment gateway, your customers' payments settle <strong>directly to your account with that provider</strong>. ${COMPANY} does not receive, hold, or control those funds at any point, and does not act as a payment processor, escrow agent or money transmitter.`,
    `Your relationship with your payment provider is governed by your agreement with them. Chargebacks, settlement timing, holds, payout failures and refunds out of your own balance are matters between you and that provider.`,
    `Using the payment keys you give us, we create payment requests for your orders, check payments, complete payments your customers have authorised, and send refunds that you or your staff start. Refunds come out of your own balance with your provider. If a customer pays after their order has expired, we record the payment and tell you; returning it is up to you. We never send money back on our own. We accept only live payment keys, not test keys.`,
    `Where you accept cash or take payment on an external card or UPI terminal, ${COMPANY} records what your staff enter. We do not verify that the money was received, and a record in the dashboard is not proof of payment.`,
  ),

  section(
    "4. Plans, fees and billing",
    `You pay ${COMPANY} for the software. Our pricing page shows our current plan prices. If we charge GST, our invoice shows it. A paid plan you buy starts once its first payment is confirmed.`,
    `A monthly plan runs for 30 days and a yearly plan for 365 days, so your renewal date is not the same calendar date each time.`,
    `If you set up automatic payment, you allow us to collect each renewal, up to the maximum you approved, until you cancel your plan or withdraw your approval with your bank or app. We email you the invoice about 4 days before your cycle ends, when we ask your bank or app to collect it. Some renewals cannot be collected automatically, for example when the amount is above the maximum you approved or above what banks allow without your extra approval, or when you have not set up automatic payment. Then you pay the invoice yourself from Plans &amp; Billing before your cycle ends.`,
    `If your renewal is not paid by the end of your cycle, your plan continues and you have at least 48 hours more to pay. We email you when the invoice is issued, when it is overdue and when your plan ends. If it is still unpaid after that, your paid plan ends and your store moves to the Free plan, and any POS shift still open is closed. You can no longer pay that invoice; to return to a paid plan, subscribe again.`,
    `Moving to a lower plan never deletes your data. What you already have stays, but you cannot add more than the new plan allows, and features the new plan does not include pause until you move up again, for example your custom domain, online payments, POS and WhatsApp.`,
    `A change of plan or billing period that costs more than you pay now starts at once, and you pay the difference for the rest of your current cycle. A change that costs the same or less starts when your current cycle ends. If you cancel, your plan stays until the end of your current cycle, and you can change your mind before then. Cancelling stops automatic payment at once, but it cannot stop a renewal payment that is already under way; if you change your mind, your plan continues, but you then pay each renewal yourself. We do not refund fees for a cycle that has already started, except where these Terms say so or the law requires it. If you cancel, we refund any renewal payment we received for a cycle that your plan does not reach.`,
    `We may change our prices. If the price of your plan or of your extra locations changes, we email you at least 1 month before the new price applies to you, and a new price never changes a cycle you have already paid for. The price of anything you buy once, such as Mink credits, is shown before you pay.`,
    `Some plans include a number of locations for selling in person. An extra location costs the price shown in your dashboard before you add it, for every cycle. Adding one starts at once and you pay for the rest of your current cycle. Removing one takes effect when your cycle ends. You cannot pay for fewer locations than you have, and we may refuse to add one if your next renewal would be above the maximum you approved for automatic payment.`,
    `We may offer you a higher plan free for a set time, and we may withdraw an offer you have not accepted. A free upgrade starts when you accept it and ends on the date we tell you then. You keep paying for your own plan during it, and when it ends your store goes back to the plan you pay for. It has no cash value.`,
    `Your invoices are in Plans &amp; Billing, including invoices for Mink credits you buy. Give us your correct GSTIN if you want it on your invoices; we cannot change an invoice once it is issued.`,
  ),

  listSection(
    "5. Accounts and services you connect",
    `Some features work by connecting an account you hold with another company. When you connect one, you let us keep the details you give us, securely, and use them to act on that account for you, for example to take payments, send refunds, book shipments and send messages. The account and everything done through it stay yours. You must own the account or be allowed to use it, and you must follow that company's terms and any registration the law requires. This includes:`,
    [
      `<strong>Payment gateways</strong>: your merchant account, your settlement, your chargebacks.`,
      `<strong>WhatsApp</strong>: you connect your own WhatsApp Business account through Meta. You let us manage it for the features you use: setting up your number, creating message templates in your account, and sending and receiving messages for you. If you also use the WhatsApp Business app on that number, the messages you send from the app are copied into your ${COMPANY} inbox as well. Meta's terms and policies apply to you. Meta reviews your templates, can pause them or limit your number, and charges you for messages. A number can be connected to only one store. Disconnecting stops these features.`,
      `<strong>SMS</strong>: messages go through your own SMS provider account and your registration with Indian telecom operators (DLT). You are responsible for your sender registration, your approved message templates and the consent behind every number you message. We send only messages built from the templates you have added. We do not read replies to your text messages, so if a customer replies to stop messages, you must act on it yourself, as section 4 of our Acceptable Use Policy explains. Your provider charges you for each message.`,
      `<strong>Shipping and logistics</strong>: rates, bookings, pickups, loss, damage and delay are between you and the carrier. We book shipments, labels and pickups on your account when you or your staff ask. Where measurements are missing we may use conservative defaults to obtain a quote, and a quote is an estimate, not a promise. Carrier charges, including charges for weight differences, are yours. If you offer free delivery, you still pay the carrier.`,
      `<strong>Analytics and advertising tags</strong>: anything you add sends your customers' data to your own accounts, on your own instructions. We load these tags only after a shopper allows them on your store. You are responsible for your provider's terms and for telling your customers how you use their data.`,
      `<strong>Custom domains</strong>: you must own the domain and keep its records pointing at us. We set up its security certificate and send visitors from your ${COMPANY} address to it, and once your store is open we register it with search engines under our account. Once your domain is set up for email, your store's emails are sent from it through our email provider. If the domain stops working, we switch your store back to its ${COMPANY} address and email you. A domain can be connected to only one store.`,
    ],
    `Automations you switch on act for you without asking each time, for example WhatsApp automatic replies, buttons that let a customer confirm or cancel a cash-on-delivery order that has not shipped, reminders, and the automatic cancellation of cash-on-delivery orders nobody confirmed. Some work by default once you connect the channels they need, unless you switch them off, for example a WhatsApp chat button on your store and, if you use both WhatsApp and SMS, an order update sent by SMS when it cannot be sent on WhatsApp, which your SMS provider charges you for. You are responsible for what automations send and do.`,
    `We are not responsible for a third party's availability, pricing, accuracy or decisions, and disconnecting one may disable the features that depend on it.`,
  ),

  section(
    "6. Selling in person",
    `If you use POS, you decide who may use it and on which devices, and you are responsible for them. Staff set their own sign-in details; you approve the devices POS runs on. Staff act for you, not for us.`,
    `When you sell with POS, we ask for each customer's mobile number and first name, and we may send a code to the order's phone to confirm a pickup or a return. You must tell your customers why you collect these details.`,
    `You are responsible for counting your own cash. Drawer figures, shift reports and variance in the dashboard are a record of what your staff entered and what our software calculated from it. They are not an audit, and we do not reconcile them against your bank.`,
  ),

  section(
    "7. Invoices, tax documents, offers and customer balances",
    `Our software can produce invoices, credit notes and tax breakdowns from the settings and rates <strong>you</strong> configure. Those documents are yours. <strong>You are responsible for whether they are correct, whether they are the right document, and for your own filings and record-keeping.</strong> We do not provide tax advice and do not verify a rate, a registration number or a serial against any authority.`,
    `Offers, free gifts, cashback and store credit you give are your promises to your customers, and you are responsible for them, including how they are taxed. Automatic offers apply to qualifying orders by themselves, within the limits you set. Cashback is added to the customer's store credit once their order is paid, or delivered if they pay cash on delivery, and we take it back if that order is cancelled or refunded, as far as their balance allows. Store credit you give does not expire on ${COMPANY}. Any amount owed to a customer is owed by you, not by us, and closing your account does not cancel it.`,
  ),

  section(
    "8. Mink AI",
    `Mink AI is the AI assistant in your dashboard, and it is part of every plan. It can answer questions from your store's data; draft changes for you to approve, such as products, offers, blog posts, emails, pages and code; redesign your storefront; make and edit photos of your products; write descriptions; turn your voice into text and read answers aloud; read files you attach; remember preferences you choose to save; run reports and regular checks you ask for; and, if you switch it on, answer your customers on WhatsApp or draft replies for you to send. Mink AI works through other companies' AI services, which our Privacy Policy describes.`,
    `<strong>Output can be wrong, incomplete or misleading.</strong> Figures, summaries, recommendations and drafts are not advice (not legal, tax, financial, medical or professional advice of any kind) and must be checked against your own records before you rely on them or publish them.`,
    `Before Mink AI changes your store, it shows you what it will do and you choose whether to apply it. <strong>Your approval is your instruction</strong>, and the result is your responsibility as if you had made the change yourself. Many changes go live as soon as you apply them. For example, when you apply an AI storefront redesign, the new products it creates go on sale straight away, with stock not counted until you change that. Your tagline, the categories you agreed to and the hiding of sample products also change at once. Its pages wait in your Website Builder draft until you publish them. Check before you apply.`,
    `If you approve something to happen later, such as a scheduled blog post or email, it happens at that time without asking you again.`,
    `Some AI features act without asking you each time, once you switch them on. If you let Mink AI answer your customers on WhatsApp, it replies to them from your number using your store's information, and no one checks each reply before it is sent. It passes complaints, refunds, cancellations and similar requests to you or your staff. You are responsible for those replies as if you had sent them. Keep your store's information accurate, and if you want a person to check every reply, switch the feature off or let Mink AI only draft replies.`,
    `Mink AI can make or edit photos of your products. When it retouches a photo of your product, places the product in a new scene or makes a new photo of it, it redraws the product, so small details may change. Compare every AI photo with the real item before you use it, and do not use a photo that shows your product as different from what a customer will receive. Mink AI is designed to add a person to a product photo only if you ask for one. Photos it makes for an AI storefront redesign may show people wearing or using your products. Any person Mink AI adds is meant to be an AI-made adult, never a child or a real or famous person.`,
    `Do not remove or hide any label, watermark or information that shows an image was made by AI. Where the law requires you to tell customers that an image was made or changed by AI, you must do so.`,
    `Mink AI uses Mink credits. Your plan includes credits that renew every 30 days or every calendar month, and unused ones do not carry over; Plans &amp; Billing shows when yours renew. You can buy more. Credits you buy do not expire and are used after your plan's credits. We decide how many credits each task uses, which can depend on how much work it takes. If we raise the credits a kind of task uses, we email you at least 1 month before the change applies, and it applies only to later use. Some features use credits each time they act, for example when Mink AI answers your customers. We do not charge credits for a request that fails. Everyone you let use Mink AI uses the same credits. Credits are not money: they cannot be exchanged for cash or moved to another store, they cannot be refunded except where the law requires it, and they end when your store is deleted.`,
    `The permissions you give your staff decide who can use Mink AI and which of its changes they can approve. You are responsible for how your staff use it.`,
    `When you send a message, Mink AI also reads what is on your screen so that it understands what you mean. Before what it reads is sent, it hides the email addresses, phone numbers and postal addresses it recognises there, but it may not recognise every one, and names and order details are still sent. Our Privacy Policy explains more.`,
    `If you talk to Mink AI, a speech-to-text service turns your voice into text. Mink AI can read its answers aloud using your browser's own voice or a text-to-speech service. These services may keep what you say, and the answers, for a limited time, may use them to improve their own services, and may process them outside India, under their own terms. We do not keep your recordings.`,
    `Mink AI can remember a preference you choose to save, for the time you choose, and can run reports and regular checks you ask for. These never change your store.`,
    `We keep each Mink AI chat for about 3 months after you last use it, then delete it. Using a chat means sending a message in it or opening it. You can see and search all your chats from that time. You can delete a chat whenever you like, except while Mink AI is still answering you or still making a storefront redesign in that chat. Deleting a chat never undoes a change you approved or published from it: the change stays in your store, and we keep a record of what Mink AI proposed and what you approved for as long as your store exists. Once a chat is deleted, a storefront redesign in it can no longer be applied or undone from Mink AI; anything you already applied stays.`,
    `Images you attach to Mink AI, and pictures Mink AI makes for you, such as product photos and the photos for a storefront redesign, are saved with your store's files, at a public web address that anyone can find and open. Deleting the chat does not delete them, and they can stay until your store is deleted. Do not attach images of private documents or of customers' details.`,
    `We do not use your data or your customers' data to train our own models. The other companies whose AI services we use process it under their own terms, not ours.`,
  ),

  section(
    "9. Code and scripts you add",
    `You may add your own HTML, CSS and JavaScript to your storefront. We run it inside a restricted frame to limit what it can reach, but <strong>that is a precaution, not a guarantee</strong>, and it does not make the code safe or lawful.`,
    `Code you add, or code you approve from an AI feature, is your content under section 2. You are responsible for what it does to your customers, for anything it loads from elsewhere, and for any consent its behaviour requires. We may disable code that harms your customers, other merchants, or the platform.`,
    `Custom code is available on some plans, and stops showing on your store if you move to a plan without it. Code you add must respect your customers' choices about cookies and tracking. Code Mink AI writes goes live only after you approve it and publish it.`,
  ),

  listSection(
    "10. Your responsibilities",
    `You must comply with all laws that apply to your business, including consumer protection, product safety, labelling, advertising, tax, and data protection law, and you must obtain any licence or registration your trade requires. You run your own online shop, so the law treats you as an e-commerce business. Among other things, you must:`,
    [
      `show your legal name, the full address of your head office and of every branch, and how to reach your customer care, including an email address and a phone number;`,
      `name a grievance officer for your store, show their name, designation and contact details, acknowledge complaints within 48 hours and resolve them within 1 month;`,
      `show your terms, refund and cancellation, delivery, warranty and return policies, and the full price including any extra charges, before the customer pays;`,
      `show the details the law requires for each product, such as the country of origin, the importer's name and details for imported goods, and, for packaged goods, the maker or packer, the net quantity and the best-before date;`,
      `record a customer's agreement to buy only through a clear action of theirs, never a box ticked for them;`,
      `not charge a customer for cancelling unless you would bear a similar charge if you cancelled;`,
      `not manipulate prices or treat customers of the same kind unfairly;`,
      `take back goods and refund their price when they are defective, not as described, or delivered late for a reason within your control; and`,
      `refund customers in the time and way the law requires.`,
    ],
    `From 1 January 2027 you must also, among other things: show the lowest price of the previous 30 days next to any price cut, label sponsored listings and not manipulate search results, give a complainant a copy of their complaint as recorded, take part in the National Consumer Helpline process, and check your store every year for designs that mislead customers and display the certificate the rules require. ${COMPANY} does not do these things for you. Our product editor has no separate field for some of these details; put them in the product description. When your selling price is below your base price, your store shows the base price struck through with the percentage off, but not the lowest price of the previous 30 days, so from 1 January 2027 you must put that lowest price in the product description.`,
    `Before your store opens you must publish your terms and conditions, refund and cancellation, shipping and privacy policies, and keep them accurate. At checkout we ask your customers to accept your terms and your refund and cancellation policy, and we record that they did. Make sure your store settings, such as your return window and cancellation rules, match what your policies say.`,
    `Your store may show things your customers write, such as reviews, comments, blog posts and messages. You must check them and remove anything unlawful. If you cannot remove something yourself, ask us.`,
    `Some orders are cancelled automatically, for example unpaid online orders and pickups nobody collects in time. We never send money back on our own; if a customer is owed a refund, we tell you and you decide.`,
    `Deleting a customer from your dashboard also deletes their orders and saved addresses. Keep any records the law requires before you delete a customer.`,
    `If you sell to children, or children are likely to use your store, you must follow the law on children's personal data, including getting a parent's consent where it is required, and you must not track children or target advertising at them. On the Pro plan, our own measurement of visits may run once a shopper allows analytics, and you cannot switch it off for your store.`,
    `Your store stays private behind a password until you choose to open it. Orders placed by anyone you give the password to are real orders.`,
    `You are responsible for everything posted through your account, for keeping your credentials secure, and for the actions of anyone you invite to your dashboard or authorise to use POS.`,
    `You must comply with our Acceptable Use Policy, which forms part of these Terms.`,
  ),

  listSection(
    "11. Your data and your customers' data",
    `You keep ownership of your content and your customer data. You give us the limited licence we need to host, process, back up, send and display it in order to run ${COMPANY} for you, including sending it to the providers described in our Privacy Policy. For your customers' personal data, <strong>you are the Data Fiduciary (the controller) and ${COMPANY} is your Data Processor</strong>. For that data we will:`,
    [
      `use it only to run ${COMPANY} for you, as these Terms and your settings say, and for the few purposes of our own that our Privacy Policy describes, such as stopping abuse, and disclose it only where section 4 of our Privacy Policy allows;`,
      `keep it confidential and protect it with reasonable security, except in images you attach to Mink AI, which are saved at a public web address that anyone can find and open (section 8), and in what you say to Mink AI by voice, which our voice services handle under their own terms;`,
      `use only the providers described in our Privacy Policy to process it;`,
      `tell you without delay if we learn of a breach that affects it, with what we know, so you can tell your customers and the authorities;`,
      `help you answer your customers' requests to see, correct or delete their data; and`,
      `delete it when your store is deleted, except what our Privacy Policy says we keep, for example because the law requires it.`,
    ],
    `You are responsible for having a lawful basis to collect that data, for the notices and consents your customers are entitled to, and for the instructions you give us through the settings you choose.`,
    `Our Privacy Policy explains what we do with the data we hold.`,
  ),

  section(
    "12. Our themes, your content and what Mink AI makes",
    `Our themes, including their designs, code, sample text and photos, are provided for use on ${COMPANY}. While you use ${COMPANY}, you may use the theme you choose on your ${COMPANY} store. Do not copy our themes, or their sample text or photos, for use anywhere else. We may change or stop offering a theme; your store keeps the version you installed.`,
    `We do not claim ownership of what Mink AI makes for you. Others may get similar results, and AI-made material may not be protected by copyright. Only give Mink AI photos, screenshots and text you have the right to use. When you ask Mink AI to make your store look like another site, it follows only that site's layout, colours and general style, never its words or pictures.`,
  ),

  section(
    "13. Availability, beta features, and changes to the service",
    `We work to keep the service available, but we do not guarantee uninterrupted or error-free operation. We may change, add or remove features. If a change takes away or materially reduces a main feature of your paid plan, we tell you at least 1 month before it happens. If you do not want to continue, write to us and we will cancel your plan and refund the fees for the part of your current cycle after the change.`,
    `Features labelled beta, preview or alpha are made available so you can try them. They may be incomplete, may change without notice, and may be withdrawn. They carry no availability expectation and, to the extent the law allows, no liability.`,
    `Some functionality depends on other companies: payment gateways, logistics, email, SMS and WhatsApp delivery, hosting, location lookups, and AI and voice services. Their outages, limits and decisions are not within our control.`,
  ),

  section(
    "14. Suspension, termination and closing your store",
    `You may stop using the service at any time. Stopping does not cancel your plan: to stop renewals, cancel it in Plans &amp; Billing.`,
    `We may suspend or terminate an account that breaches these Terms or the Acceptable Use Policy, that exposes us or our other users to legal risk or harm, or where required by law. Where practical and lawful, we will tell you why and give you an opportunity to put it right. We may suspend immediately and without notice where the risk is serious. We act without notice, within the time the law sets, when a court or government order requires it.`,
    `While your store is suspended, your storefront and dashboard are closed. Suspension does not stop your plan's fees, but you can cancel your plan by writing to <a href="mailto:support@storemink.com">support@storemink.com</a>, and if we suspended your store by mistake, we refund the fees for the time it was suspended.`,
    `While your account is active, you can download your products, categories, stock and orders as spreadsheet files from your dashboard at any time. For anything you cannot download yourself, or if we close your account, write to us and we will help you get a copy within 30 days.`,
    `To close your store and delete its data, write to <a href="mailto:support@storemink.com">support@storemink.com</a> from the store owner's email address. Deleting a store is permanent. It removes everything in it, including your orders, your customers' accounts with your store and the files you uploaded, so first download what you must keep, for example for tax. We keep our invoices to you, as the law requires, and the record that you accepted these Terms. Our Privacy Policy explains what else we keep and for how long.`,
  ),

  section(
    "15. No warranties",
    `The service is provided <strong>"as is" and "as available"</strong>. To the fullest extent permitted by law, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.`,
    `We do not warrant that the service will meet your requirements, that it will be secure against every attack, that any defect will be corrected, or that any figure, report or generated output is accurate or fit for the use you put it to.`,
  ),

  section(
    "16. Limitation of liability",
    `To the fullest extent permitted by law, ${COMPANY} is not liable for indirect, incidental, special, consequential or punitive damages, nor for lost profits, lost revenue, lost sales or lost goodwill. We are not liable for lost or corrupted data unless our own breach of these Terms or our negligence caused it.`,
    `We are also not liable for loss arising from a decision you took on the basis of a figure, report or generated output, from a third-party service you connected, from cash or tender handling at your counter, or from a tax document our software produced from settings you configured.`,
    `Our total aggregate liability arising out of or relating to the service is limited to <strong>the fees you actually paid to ${COMPANY}, including for Mink credits and extra locations, in the 12 months before the event giving rise to the claim</strong>.`,
    `Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or limited, including liability for death or personal injury caused by negligence, and liability to pay the compensation the law requires when we fail to protect personal data. The limits in this section do not apply to loss caused by our fraud, our wilful misconduct or our gross negligence.`,
  ),

  section(
    "17. You indemnify us",
    `You will defend and indemnify ${COMPANY}, its partners and employees against any claim, loss, liability or cost (including reasonable legal fees) arising from your products, your content, your use of the service, your breach of these Terms or the Acceptable Use Policy, or your breach of any law or third-party right, including any claim brought by one of your customers, by your staff, by a provider you connected, or by an authority.`,
    `This includes claims arising from output you approved or published from an AI feature, from code or scripts you added, from messages you sent, from messages sent by features you switched on, including Mink AI replies to your customers, and from tax documents issued through your store.`,
    `You do not have to indemnify us for a claim, or the part of a claim, that was caused by our own breach of these Terms or of the law, including a failure to protect personal data, by our negligence or wilful misconduct, or by what we do with personal data for our own purposes. Nor do you have to pay a fine or penalty imposed on us for our own failure.`,
  ),

  section(
    "18. Feedback",
    `If you send us ideas, suggestions or bug reports, you allow us to use them to improve the service without obligation or payment to you. You keep whatever rights you already had; we simply do not owe you anything for acting on a suggestion.`,
  ),

  section(
    "19. Events outside our control",
    `Neither party is liable for a failure to perform caused by something beyond its reasonable control, including a failure of a network, hosting or payment provider, a cyber attack, an act of a public authority, industrial action, or a natural event. Your obligation to pay for a period you used the service is not excused by this section.`,
  ),

  section(
    "20. Transfer of this agreement",
    `You may not assign or transfer these Terms without our written consent. We may transfer them to a buyer of our business or assets, or to a group company, only if it takes on our duties to you under them. We will tell you at least 1 month before the transfer, so that you can cancel your plan or close your store first if you do not want to continue.`,
  ),

  section(
    "21. Notices",
    `We send notices by email to the email address on your account or the billing email address you gave us, or in your dashboard. Keeping those addresses current and monitored is your responsibility, and a notice we send to them is effective whether or not you read it. Some emails about your account, billing, security and domain cannot be switched off, because they are part of the service. We send news about new features only if you asked for it; to stop it, write to <a href="mailto:support@storemink.com">support@storemink.com</a>. You can reach us at <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),

  section(
    "22. General",
    `You may not resell, sublicense, or offer the service to others as your own product without our written agreement.`,
    `If a provision is held unenforceable, the rest stays in force and that provision applies to the maximum extent permitted. A delay in enforcing a right is not a waiver of it. Nothing in these Terms takes away a right that the law does not let you give up.`,
    `These Terms, together with the Acceptable Use Policy and the Privacy Policy, are the entire agreement between us about the service, and replace anything said before.`,
  ),

  section(
    "23. Changes to these Terms",
    `We may update these Terms. Every version is published with a version number and the date it takes effect. When we publish a new version, we show it in your dashboard and ask you, and the people you invite to your dashboard, to accept it before you carry on. If you do not accept it, you can stop using ${COMPANY}; write to us and we will cancel your plan and refund the fees for the part of your current cycle that is left. We keep every earlier version and will send you a copy if you ask.`,
  ),

  section(
    "24. Complaints and our Grievance Officer",
    `If you have a complaint about ${COMPANY}, about something published on a store built on ${COMPANY}, or about how we handle personal data, write to our Grievance Officer:`,
    `Anurag Goyal, Grievance Officer, STOREMINK LLP`,
    `Email: <a href="mailto:support@storemink.com">support@storemink.com</a>`,
    `Registered office: Faridkot, Punjab, India`,
    `Tell us who you are, how we can reach you, what the complaint is about, and the web address of the store or page it concerns.`,
    `We acknowledge every complaint within 24 hours and resolve it within 7 days. We resolve within 36 hours a request to remove content of a kind listed in section 2 of our Acceptable Use Policy, unless the only reason given is that the content belongs to someone else, infringes a patent, trademark, copyright or other right, or breaks any other law.`,
    `If content shows you, or a person you act for, fully or partly naked, with private parts exposed, or in any sexual act or conduct, or if it pretends to be you or that person, for example in a faked or morphed image, we remove it or block access to it within 2 hours of receiving your complaint. Write "Urgent" in the subject line so that we see it at once.`,
    `If you are not satisfied with our decision, or we do not resolve your complaint within these times, you can appeal to the Grievance Appellate Committee at gac.gov.in within 30 days.`,
  ),

  section(
    "25. Governing law and courts",
    `These Terms are governed by the laws of India. The courts at Faridkot, Punjab have exclusive jurisdiction over any dispute arising out of or relating to these Terms or ${COMPANY}.`,
  ),

  section(
    "26. Contact",
    `Questions about these Terms: <a href="mailto:support@storemink.com">support@storemink.com</a>. Our registered office is at Faridkot, Punjab, India.`,
  ),
].join("\n");

// ── Privacy Policy ──────────────────────────────────────────────────────────
const PRIVACY_BODY = [
  `<p><em>Version 4</em></p>`,
  `<p>This policy is published by ${ENTITY}. In this policy, "${COMPANY}", "we", "us" and "our" mean STOREMINK LLP.</p>`,
  `<p>This policy is available in English and, on request at <a href="mailto:support@storemink.com">support@storemink.com</a>, in any language listed in the Eighth Schedule to the Constitution of India.</p>`,

  section(
    "1. Who we are, and the two roles we play",
    `We decide how and why we use the personal data in this paragraph, so for it we are the Data Fiduciary (the controller): the accounts of merchants and their staff; our billing; how you use our dashboard, POS and Mink AI; people who visit storemink.com and our Help, Themes and POS sites; people who use our Help Centre assistant; and people who write to us.`,
    `For the personal data customers give to a store, such as names, addresses and orders, the merchant is the Data Fiduciary and we are its Data Processor: we handle that data for the merchant and on its instructions. If you shopped at a store built on ${COMPANY}, see section 8.`,
    `For a few things we use shoppers' data for our own purposes, across all stores: running the sign-in service that stores use, keeping a single list of email addresses that bounced or were reported as spam so that no store keeps mailing them, using IP addresses to stop abuse, and keeping the record that a shopper accepted a store's policies.`,
    `In this policy, "you" means a merchant or a person who works on a merchant's store, except in section 8, which speaks to shoppers.`,
  ),

  listSection(
    "2. What we collect",
    `We collect the following, and use each for the purpose given with it:`,
    [
      `Account data: your name and email address; your password or, if you sign in with Google, your Google account's name and email address; your mobile number once you verify it with a code; your store's name and country; the business details you add for invoices, such as your legal or business name, address, state, GSTIN, billing email and phone; and whether you asked for product news. We use it to run your account, keep it secure, contact you and bill you. Your password is held by our sign-in provider, Google, in a form that cannot be read back. When you set or change your password, or confirm it before a sensitive change, our servers may pass it to Google; we never store it.`,
      `Staff data: for people you invite, their name, email address, role and the locations you assign them. For POS staff, also the mobile number they verify with a code and their 8-digit POS PIN, which we store in a form that cannot be read back. For POS we keep which devices were approved, by whom and when, and a record of sign-ins, failed sign-ins, discounts, price changes, refunds, cash movements and other exceptions, with the IP address used. We use it to give each person the access you chose and to show you who did what.`,
      `Store data: what you and your customers put into your store, including products, pages and files you upload; orders with delivery details and GSTIN; customer accounts and saved addresses; reviews and comments; enquiries; newsletter sign-ups; store credit; WhatsApp conversations and contacts with their messaging choices; and records of customers accepting your store's policies. We use it to run your store for you and your customers.`,
      `Usage and technical data: IP address, browser and device details, and records of requests, errors, and the emails and messages we send. Some of this is security evidence: we record the IP address and browser used when someone accepts our policies, and the IP address used when a POS device is approved. We use it to run the service, keep it secure and fix problems.`,
      `AI interactions: what you type or say to Mink AI, files and images you attach, what is on your screen when you send a message (see section 5), notes you ask it to remember, the context we gathered to answer, the answers, the changes you approve, and any rating or report you send us. We use it to answer you, to keep a record of the changes you approve, and to look into problems you report.`,
      `Payment data: we never store card numbers. We keep the payment provider's references, amounts, status and payment method type, and, for automatic payment, the maximum amount you approved. To set up automatic payment we give Razorpay your store's name, billing email address and mobile number. We use it to take and record your payments to us.`,
      `Support: what you tell us when you write to us. We use it to help you.`,
      `Visitors to our websites: IP address and browser details, and the questions you type into our Help Centre assistant. We use them to show our websites, stop abuse and answer your questions.`,
    ],
  ),

  listSection(
    "3. Why we use it, and on what basis",
    `We use personal data:`,
    [
      `to provide the service you signed up for and the features you switch on, including Mink AI, because you asked for them;`,
      `to bill you and keep our accounts and tax records, because the law requires it;`,
      `to send you and your staff the messages the service needs: order alerts, security notices, billing, and notices about changes to the service;`,
      `to support you when you ask;`,
      `to keep ${COMPANY} secure and to detect abuse and fraud;`,
      `to meet legal obligations and lawful requests from authorities; and`,
      `with your consent, to send you news about new features, if you said yes at signup.`,
    ],
    `You can withdraw a consent at any time. To stop product news, write to <a href="mailto:support@storemink.com">support@storemink.com</a>. Withdrawing does not affect what we did before.`,
    `We do not sell personal data, and we do not use your data or your customers' data to train our own models.`,
  ),

  listSection(
    "4. Who we share it with",
    `Providers who process data for us under contract, so that the service works:`,
    [
      `Google Cloud: hosting, database and file storage.`,
      `Google Identity Platform: accounts and sign-in for merchants, staff and shoppers, the SMS codes used to verify a phone number, and Google reCAPTCHA checks that stop abuse of those codes.`,
      `Google Vertex AI: our AI features, including Mink AI, Generate with AI, Mink AI replies to customers on WhatsApp and the Help Centre assistant. See section 5.`,
      `A speech-to-text service: turning what you say to Mink AI into text. See section 5.`,
      `A text-to-speech service: reading Mink AI's answers aloud, when we use one. See section 5.`,
      `Resend: email delivery, including the emails stores send to their customers, and delivery outcomes such as bounces and complaints.`,
      `Razorpay: your payments to us for plans, extra locations and Mink credits, including automatic payments.`,
      `Meta (WhatsApp): when a store connects a WhatsApp Business number, messages to and from that number, with their photos and voice notes, pass through Meta, and we keep them for the store's inbox. If the store also uses the WhatsApp Business app on that number, messages sent and received there are copied into the inbox too.`,
      `Google Search Console: search performance for launched stores, their sitemaps, and the custom domains we verify for stores.`,
      `Our email service for <a href="mailto:support@storemink.com">support@storemink.com</a>: the messages you send us, including complaints and requests about your data.`,
    ],
    `When a shopper taps "Use my current location", their browser sends the device's position to BigDataCloud, a free location service, to find the PIN code. BigDataCloud handles it under its own terms.`,
    `Where you connect an account of your own (a payment gateway, a logistics provider such as Shiprocket, an SMS provider such as Twilio, or an analytics or advertising tag), our software sends data to it on your instructions. Those providers act for you, under your agreement with them, and this policy does not govern what they do with it. Shipping a parcel sends your customer's name, address and phone to the carrier; sending an SMS sends their number and the message.`,
    `Some pages also load content from other companies, such as videos from YouTube or Vimeo, a font from Google Fonts and a country flag from GitHub; section 11 explains when.`,
    `We may also disclose data where the law requires or allows it: to a government agency authorised by law that asks in writing, to obey a court order, to enforce or defend a legal right or claim, to prevent, detect or investigate an offence, or to help in an emergency that threatens someone's life or health.`,
  ),

  section(
    "5. Mink AI and your data",
    `When you use an AI feature, we send Google Vertex AI what that request needs: your store profile and brand settings, and the catalogue, sales, stock, order or Website Builder content the request is about. This can also include the earlier messages in that conversation, notes you asked Mink AI to remember, files and photos you attach, your store's own product photos, which may show people, and what you tell Mink AI when it redesigns your store.`,
    `If you speak to Mink AI, your recording is sent to a speech-to-text service, which turns it into text; the text is then handled like a message you typed. When we use a text-to-speech service to read answers aloud, the text of each answer is sent to it; otherwise your browser reads answers aloud with its own voice. We do not keep your recordings. These services may keep what they receive for a limited time, may use it to improve their own services, and may process it outside India, under their own terms.`,
    `When you send a message, Mink AI also reads what is on your screen, such as the rows of a list or the fields of a form you have open, so that it understands what you mean. Before what it reads is sent, it hides the email addresses, phone numbers and postal addresses it recognises there. It may not recognise every one, and names, order details and other information on screen may still be sent. It does not send password fields, or fields whose label names a password, secret, token, API key, OTP or PIN. When Mink AI looks up orders or customers itself, it uses only a customer's first name and the first letter of their last name. Files you attach are sent as they are, so do not attach screenshots that show customers' contact details unless your request needs them.`,
    `If a store lets Mink AI answer, or draft replies to, its customers on WhatsApp, the customer's message, the recent conversation and that customer's own orders are sent to Google Vertex AI to write the reply.`,
    `Google Vertex AI processes what we send in order to return an answer. Google's terms for this service do not allow it to use what we send to train its models, and we do not use your data to train models of our own. Google may keep what we send for a limited time under its own terms: briefly, to deliver the service, and longer if its systems flag a request for an abuse check.`,
    `We keep each Mink AI conversation for about 3 months after you last use it, and then delete it. Using a conversation means sending a message in it or opening it. You can see and search all your conversations from that time. You can delete a conversation whenever you like, except while Mink AI is still answering you or still making a storefront redesign in that conversation. Deleting a conversation never undoes a change you approved or published from it: the change stays in your store, and we keep a record of what Mink AI proposed and what you approved for as long as your store exists. For a storefront redesign you applied, that record also keeps the answers you gave Mink AI for it. In your dashboard, your conversations are visible only to you, not to others who work on your store.`,
    `Notes you ask Mink AI to remember are kept for the 30, 90 or 365 days you choose, and then deleted. Product spreadsheets you attach are kept for 7 days. What Mink AI reads from a file or image you attach becomes part of the conversation.`,
    `Images you attach to Mink AI, and pictures Mink AI makes for you, such as product photos and the photos for a storefront redesign, are saved with your store's files, at a public web address that anyone can find and open. Deleting the conversation does not delete them, and they can stay until your store is deleted. Do not attach images of private documents or of customers' details.`,
    `Where our support team needs to look at a reported answer, the detail we store for that purpose is reduced first.`,
    `Public Help Centre answers work the same way: the question you type and the published guides we retrieved are sent to the model. Do not put passwords, card numbers or anyone else's personal details into an AI prompt.`,
  ),

  listSection(
    "6. Where it is held, and for how long",
    `Most of your store's data and files are stored on Google Cloud in Mumbai, India. Some data may be handled outside India, under the providers' own safeguards and as Indian law allows:`,
    [
      `requests to our AI features, which Google may process in any country where it runs Google Vertex AI, including the United States;`,
      `voice, which our speech services may process outside India;`,
      `sign-in accounts held by Google Identity Platform, and backup copies of our database; and`,
      `data handled by our email, WhatsApp and other providers.`,
    ],
  ),
  // More of this section: the <ul> markup listSection writes, for a list
  // that does not follow the section's first paragraph.
  `<p>We keep your account and store data while your store exists, including after a paid plan ends, so nothing is lost if you come back. This includes records with no set period, such as your POS activity record and the records of messages sent for your store. Some records are deleted on a schedule:</p>`,
  `<ul>`,
  `<li>in-app notifications: 90 days;</li>`,
  `<li>our log of the emails we send, with a copy of each email: 90 days;</li>`,
  `<li>our log of the WhatsApp messages we send for your store, with a copy of each message: 90 days;</li>`,
  `<li>your store's activity log: 1 year;</li>`,
  `<li>raw records of storefront visits: 14 days, after which we keep only daily totals;</li>`,
  `<li>files you upload to import: deleted when the import finishes; import logs: 90 days;</li>`,
  `<li>product spreadsheets you attach in a Mink AI conversation: 7 days;</li>`,
  `<li>POS sales put on hold: 7 days;</li>`,
  `<li>Mink AI conversations: about 3 months after you last use them (section 5);</li>`,
  `<li>notes you ask Mink AI to remember: the 30, 90 or 365 days you choose;</li>`,
  `<li>WhatsApp conversations: kept while open, and deleted 2 years after the last message once closed; contacts and their messaging choices are kept while the store exists; and</li>`,
  `<li>search performance data: about 16 months.</li>`,
  `</ul>`,
  `<p>We keep some records longer because the law or our own protection needs them: our invoices to you, which show your business name, address, GSTIN and billing email and record what you paid, the records of your payments for plans and extra locations, and the record of any payment to us that we are still checking, for as long as tax and company law require (at least 8 years), also after your store is deleted; records that you accepted our policies, also after your store is deleted; the list of email addresses that bounced or were reported as spam, so that no store mails them again; and the counters we use to stop abuse, some of which include an IP address.</p>`,
  `<p>When a store is deleted, its data is deleted with it, except the records in the paragraph above. Copies in our database backups, and our records of requests to our service, which include IP addresses, are removed later, on their own schedules.</p>`,

  section(
    "7. Your rights and choices",
    `You can ask us for a summary of your personal data and how we use it, and for the names of those we shared it with and what we shared with each; to correct, complete or update it; to delete it; and to stop using it where you gave consent. You can also name another person to use these rights for you if you die or cannot act yourself: tell us their name and email address. To ask, write to <a href="mailto:support@storemink.com">support@storemink.com</a> from the email address on your account and tell us your store's address, so we can confirm it is you. We reply to a request or a question about your personal data within 10 working days. If you are not satisfied with our reply, see section 12.`,
    `You can download your products, categories, stock and orders as spreadsheet files from your dashboard. For anything else, including your customer list, write to us and we will help you get a copy within 30 days.`,
    `To delete your store, write to <a href="mailto:support@storemink.com">support@storemink.com</a> from the store owner's email address. Deleting a store is permanent: it removes the store's records, its uploaded files, and the sign-in accounts used only for that store; an account also used elsewhere is kept. Some records cannot be deleted on request; a record that you accepted our policies, or an invoice we must keep for tax, are examples (see section 6).`,
    `Deleting a customer from your dashboard also deletes their orders and saved addresses, so keep any records the law requires first. If you need an account or its order history removed and are unsure how, write to us first.`,
  ),

  section(
    "8. If you shopped at a store built on StoreMink",
    `The merchant decides what to collect and why; we process it for them. Ask them first: they can change or remove your details, and we will help them do it.`,
    `Signing in to a store sends a one-time code to your mobile through Google, with a check to stop abuse. We run this sign-in for every store: if you sign in at a store on a storemink.com address, you are also signed in at other stores on storemink.com addresses. When you create an account or place an order, we keep a record that you accepted the store's policies, with your IP address and browser, as evidence of what you agreed to.`,
    `A merchant may add their own analytics or advertising tags to their storefront. Those send data to the merchant's own accounts, not ours, and only after you allow that category on their site. You can withdraw that choice on the same site at any time. A merchant can also add code of their own to a page, and that code may load content from other companies without asking you first.`,
    `A store on our Pro plan may also measure visits through ${COMPANY}, but only after you allow analytics on that store. This measurement does not store an identifier in your browser; it uses a code that changes every day. It records the pages you view and the shopping steps you take, the type of device you use (desktop, mobile or tablet), the website or tagged campaign link that brought you, and your approximate location (country, state and city) as reported by your network. If you place an order, that day's visit is linked to your order. For this measurement we do not keep your IP address, your browser details or the full address of the page that referred you.`,
    `We use IP addresses to stop abuse, for example too many sign-in attempts. If an email to you bounces because the address does not work, or you mark one as spam, we stop sending email to that address from every store on ${COMPANY}.`,
    `For the things we do with your data for our own purposes, which section 1 lists, you can ask us for a summary of that data, the names of those we shared it with and what we shared with each; ask us to correct or delete it; and name another person to use these rights for you if you die or cannot act yourself, by telling us their name and email address. Some records, such as the record that you accepted a store's policies, are kept as evidence and cannot be deleted on request. Write to <a href="mailto:support@storemink.com">support@storemink.com</a> with the mobile number or email address you used and the web address of the store, so we can confirm it is you. We reply within 10 working days. If you are not satisfied with our reply, see section 12.`,
    `If you message a store on WhatsApp, the store keeps the conversation, including photos and voice notes, while it is open and for 2 years after the last message once it is closed, and keeps a record of your messaging choices. At checkout a store may ask whether you want order updates and offers on WhatsApp; the order updates box starts ticked, and you can untick it. Replying STOP turns off offers; order updates continue. If you have an account at the store, you can turn order updates and offers off on your account page. If the store lets Mink AI answer, or draft replies to, its customers, your message, the recent conversation and your own orders are sent to Google Vertex AI to write the reply, and a person from the store can take over.`,
    `If you buy at a store's counter, the store records your mobile number and your name, and your email address if you give one, and may send a code to your phone to confirm a pickup or a return. If you give an email address, the store may email you about your purchase. If you later create an account at that store with the same number, your in-store orders appear in it.`,
    `If you tap "Use my current location", your browser sends your device's position to BigDataCloud to find your PIN code. We keep only the PIN code, city and state, in your browser.`,
    `A store's pages may show videos from YouTube or Vimeo, and store blog pages load a font from Google Fonts. The mobile number box on a store's sign-in and enquiry forms shows a country flag loaded from GitHub. When you open such a page or form, your browser contacts those companies, which receive your IP address (see section 11).`,
  ),

  section(
    "9. Security",
    `We encrypt data while it travels between your device and our servers. We keep each store's data separate from every other store's data, and passwords and POS PINs are held only in a form that cannot be read back. The people you invite get only the access that the role you give them allows. People who work for ${COMPANY} can open any store's data when they need to: to help merchants, to fix a problem, to keep the service running and secure, or to meet a legal duty. Credentials you give us for a provider you connect are encrypted before storage and are never shown back to you.`,
    `Files you upload to show on your store, such as product photos, are stored at public web addresses that anyone can find and open. So are images you attach to Mink AI and photos Mink AI makes for you.`,
    `No system is perfectly secure. If a breach affects your personal data, we will tell you without delay, by email or in your dashboard: what happened, when it happened and how much of your data it affected; what it may mean for you; what we are doing about it; what you can do; and who to contact. We report security incidents to the authorities as Indian law requires.`,
  ),

  section(
    "10. Children",
    `You must be 18 or over to open a ${COMPANY} account, to work on a store's dashboard or to use a store's POS, and we do not knowingly collect children's data for our own purposes. Stores built on ${COMPANY} decide who may shop with them, and they are responsible for following the law on children's data.`,
  ),

  section(
    "11. Cookies and browser storage",
    `We use cookies that the service needs to work: to keep you signed in, to check the email code while you sign up, to remember a store password you entered, to keep a shop's POS signed in and its device approved, to confirm a customer's code in POS, and to remember that you hid a preview in your dashboard. We do not use cookies for advertising.`,
    `In your browser we keep your sign-in, your cart and any discount code you applied, the delivery PIN code, city and state you chose, your privacy choices, and, if you react to a blog post, a random code so that your reaction counts once. In the dashboard and in POS we keep layout preferences, the Mink AI conversation you have open, a form Mink AI filled in for you, and a copy of the catalogue and of the sale in progress. On our Help Centre we keep the width of the assistant panel and whether you found a guide helpful.`,
  ),
  // More of this section: the <ul> markup listSection writes, for a list
  // that does not follow the section's first paragraph.
  `<p>Other companies may set their own cookies, or receive your IP address and browser details, in these cases:</p>`,
  `<ul>`,
  `<li>a store's analytics and advertising tags, only after you allow that kind;</li>`,
  `<li>other companies whose content a store puts on its pages, such as a picture stored on another website, or content that the store's own code loads;</li>`,
  `<li>Google, when you sign in, with a password, a code or your Google account, or verify your mobile number;</li>`,
  `<li>Razorpay, when you pay;</li>`,
  `<li>Meta, when you connect a WhatsApp number from your dashboard;</li>`,
  `<li>BigDataCloud, when you tap "Use my current location";</li>`,
  `<li>GitHub, when a form shows a country flag beside the mobile number box, because the flag is loaded from there;</li>`,
  `<li>YouTube or Vimeo, when you open a page that shows one of their videos, even before you press play; and</li>`,
  `<li>Google Fonts, when you open a store's blog pages.</li>`,
  `</ul>`,

  section(
    "12. Complaints and our Grievance Officer",
    `If you have a complaint about ${COMPANY}, about something published on a store built on ${COMPANY}, or about how we handle personal data, write to our Grievance Officer:`,
    `Anurag Goyal, Grievance Officer, STOREMINK LLP`,
    `Email: <a href="mailto:support@storemink.com">support@storemink.com</a>`,
    `Registered office: Faridkot, Punjab, India`,
    `Tell us who you are, how we can reach you, what the complaint is about, and the web address of the store or page it concerns.`,
    `We acknowledge every complaint within 24 hours and resolve it within 7 days. We resolve within 36 hours a request to remove content of a kind listed in section 2 of our Acceptable Use Policy, unless the only reason given is that the content belongs to someone else, infringes a patent, trademark, copyright or other right, or breaks any other law.`,
    `If content shows you, or a person you act for, fully or partly naked, with private parts exposed, or in any sexual act or conduct, or if it pretends to be you or that person, for example in a faked or morphed image, we remove it or block access to it within 2 hours of receiving your complaint. Write "Urgent" in the subject line so that we see it at once.`,
    `If you are not satisfied with our decision, or we do not resolve your complaint within these times, you can appeal to the Grievance Appellate Committee at gac.gov.in within 30 days.`,
    `For a request about your own personal data, see section 7. If we do not resolve a complaint about your personal data, you can complain to the Data Protection Board of India, which works online, once that right comes into force.`,
  ),

  section(
    "13. Changes and contact",
    `We publish each version of this policy with a version number and the date it takes effect. When we publish a new version, we show it in your dashboard and ask you to accept it. We keep every earlier version and will send you a copy if you ask. Questions or requests: <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),
].join("\n");

// ── Acceptable Use ──────────────────────────────────────────────────────────
const AUP_BODY = [
  `<p><em>Version 2</em></p>`,
  `<p>This policy forms part of the Terms of Service between you and ${ENTITY}. In this policy, "${COMPANY}", "we", "us" and "our" mean STOREMINK LLP.</p>`,
  `<p>This policy is available in English and, on request at <a href="mailto:support@storemink.com">support@storemink.com</a>, in any language listed in the Eighth Schedule to the Constitution of India.</p>`,
  `<p>This policy applies to you, to everyone you give access to your store, and to what your customers post on your store. It exists so that one merchant's conduct cannot put every other merchant at risk.</p>`,

  listSection(
    "1. What you may not sell",
    `You may not sell anything that is illegal where you or your customer are located. In particular, you may not sell:`,
    [
      `Weapons, ammunition, explosives and their parts.`,
      `Illegal drugs, controlled substances and drug paraphernalia.`,
      `Medicines or medical devices that you do not hold the licence to sell, or that need a prescription you do not check.`,
      `Electronic cigarettes, and any other product whose sale is banned in India.`,
      `Tobacco, alcohol and cannabis products, and anything else only adults may buy, unless you hold every licence needed and check buyers' age yourself. ${COMPANY} does not check age for you.`,
      `Counterfeit, replica or infringing goods, and anything you are not allowed to resell.`,
      `Stolen goods, and stolen, scraped or leaked data.`,
      `Human remains, body parts or body fluids, and protected wildlife or products made from it.`,
      `Sexually explicit material and adult services.`,
      `Securities, virtual currency, and anything that works as a deposit, loan, insurance or investment product.`,
      `Gambling, betting, lotteries and games of chance that you are not licensed to offer.`,
      `Online money games, and anything that promotes them. These are banned in India.`,
      `Government identity documents, licences and official credentials, and fake documents of any kind.`,
      `Hazardous goods that you are not licensed and equipped to pack and ship.`,
      `Tools, services or instructions whose main purpose is to break into systems, defeat security or harass someone.`,
    ],
  ),

  listSection(
    "2. Content you may not publish",
    `You may not publish on your store, and your customers may not post there, anything that:`,
    [
      `Belongs to someone else and that you have no right to use.`,
      `Is obscene or pornographic, is sexual material involving children, or invades another person's privacy, including their bodily privacy.`,
      `Insults or harasses a person because of their gender, is racially or ethnically offensive, or promotes hatred between groups because of religion or caste in order to provoke violence.`,
      `Relates to or encourages money laundering or gambling.`,
      `Is harmful to children.`,
      `Infringes a patent, trademark, copyright or other right.`,
      `Misleads people about where a message came from, or that you know is false or misleading.`,
      `Pretends to be another person or business.`,
      `Threatens the unity, integrity, defence, security or sovereignty of India, its relations with other countries, or public order.`,
      `Encourages anyone to commit a crime, gets in the way of an investigation, or insults another country.`,
      `Contains a virus or code meant to damage, disrupt or limit any computer system.`,
      `Is an online game that harms its players or is not allowed under Indian law, or advertises or promotes such a game, or a platform that offers one, openly or in disguise.`,
      `Breaks any other law.`,
    ],
    `If you learn that something on your store breaks these rules, remove it. If you cannot remove it yourself, for example a customer's review or comment, write to <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),

  listSection("3. What you may not do", `Whatever you sell, you may not:`, [
    `Mislead customers about who you are, what you are selling, what it costs, what it is made of, or when it will arrive.`,
    `Take payment for goods you cannot supply, or refuse a remedy the law gives your customer.`,
    `Run a scheme whose returns depend on recruiting people rather than on sales, or make earnings or health claims you cannot back up.`,
    `Create false urgency or scarcity, for example a countdown that restarts or a stock count that is not true; show a "was" price or MRP that is not real; hide charges until the last step; add items or services a customer did not choose; make cancelling hard; or use any other trick the law bans, such as shaming customers into a choice, asking again and again until they give in, confusing questions, adverts disguised as reviews or news, or advertising one thing and selling another.`,
    `Post, buy, invent or selectively hide reviews or testimonials, or present AI-made people or quotes as real customers.`,
    `Use your customers' data for anything other than running your store and the purposes you told them about, or sell it, or share it with anyone who does not need it for those purposes.`,
    `Try to get into another store's data, probe or attack the platform, scrape it at a scale that slows it down, or reverse-engineer the software.`,
    `Get around usage limits or what your plan includes, for example by opening extra accounts or stores to get more of a free allowance or other free benefits, or by selling Mink credits or sharing them outside your store.`,
    `Upload malware, or use a store to phish or to pretend to be someone else.`,
    `Add code that mines cryptocurrency, collects passwords or card numbers, or tracks shoppers against their choices.`,
    `Connect a domain, phone number, payment account, messaging account or any other account that you do not own or are not allowed to use.`,
    `Use the platform mainly to host files, run a link farm or manipulate search rankings, rather than to sell.`,
    `Share a POS login or PIN, or let someone use a POS or dashboard account that is not theirs.`,
  ]),

  listSection(
    "4. Email, SMS and WhatsApp",
    `These rules apply to every email, SMS and WhatsApp message sent from your store, including automatic ones:`,
    [
      `Send marketing by email, SMS or WhatsApp only to people who agreed to receive it from your store. Order and service messages must be about a real order or account.`,
      `When someone asks you to stop, in any words and by any route, including by phone or in person, stop sending them that kind of message. Do not get around a block or a suppression list.`,
      `Some stop requests are recorded for you. On WhatsApp, a customer who replies STOP no longer gets offers from your store, though they still get updates about their orders. A customer can also switch off your WhatsApp order updates and offers in their account on your store. We do not read replies to your text messages. Any other request is yours to act on. If your dashboard cannot stop a kind of message to the person who asked, write to <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
      `Our coupon emails go to the customers you choose. We do not check whether each one agreed to marketing, so choose only customers who did, and leave out anyone who asked you to stop.`,
      `Unless your store sends email from its own domain, our email sending domain is shared with every other merchant. Spam sent from your store damages delivery for all of them, so we enforce this strictly.`,
      `For SMS, use only message templates you have registered with Indian telecom operators, and keep promotional messages apart from service messages.`,
      `On WhatsApp, follow Meta's WhatsApp Business policies and its Commerce Policy. Use each message template only for what it says it is, and give customers a way to reach a person.`,
      `Do not use WhatsApp to sell or promote weapons or explosives, alcohol or tobacco, drugs whether prescribed or not, medical and healthcare products, protected wildlife, live animals other than livestock, adult products or services, real-money gambling, dating services, multi-level marketing, payday or similar loans, or real, virtual or fake currency, even if your store may sell some of these elsewhere.`,
    ],
    `If these rules are broken, Meta or we may pause your WhatsApp, and we may pause your other messages too.`,
  ),

  section(
    "5. Using Mink AI responsibly",
    `You may not use Mink AI or our other AI features to make anything that would break this policy if you had made it yourself. In particular, do not publish AI-written claims about a product's effects, safety, ingredients or origin without checking them; do not present AI-written text as professional, medical, legal or financial advice; and do not use AI-written text or code to pretend to be another person or business.`,
    `Do not use AI images to show a product as different from what you sell, for example its colour, size, features, packaging or certification marks; to show a real person who has not agreed to it; to present AI-made people or scenes as real customers or real reviews; or to copy another brand's products, logos or photos. Do not upload photos of people unless they agreed. Do not remove or hide any label, watermark or other information that shows an image was made by AI.`,
    `Never use Mink AI, or any other tool on ${COMPANY}, to make or change sexual material involving children; intimate or sexual images of a real person without their consent; obscene, pornographic, sexually explicit, vulgar or indecent material; material that invades someone's privacy, including their bodily privacy; fake documents or records; material about making or getting explosives, arms or ammunition; or images, audio or video that falsely show a real person's identity, voice, words or actions, or a real event that did not happen, in a way likely to deceive.`,
    `Misusing AI tools to make unlawful images, video, audio or text can be punished under Indian laws, including the Information Technology Act, 2000, the Bharatiya Nyaya Sanhita, 2023, the Protection of Children from Sexual Offences Act, 2012, the Representation of the People Act, 1951, the Indecent Representation of Women (Prohibition) Act, 1986, the Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013 and the Immoral Traffic (Prevention) Act, 1956. If you misuse them, we may at once remove the content and suspend or close your account, keeping a copy of the evidence; we may give your identity to a victim who complains, or to a person who complains for them, as the law allows; and we report offences the law requires us to report.`,
    `Do not put other people's personal data, passwords or payment details into a message, an attachment or a voice message to Mink AI unless your request needs them. Mink AI also reads what is on your screen each time you send it a message. Before what it reads leaves your screen, it hides the email addresses, phone numbers and postal addresses it recognises, but it may miss some, and names and order details are still sent. So use Mink AI on pages that show customer details only when your request needs them.`,
    `Images you attach to Mink AI are saved with your store's files, at a public web address that anyone can find and open, and can stay there until your store is deleted, even after the chat is deleted. Do not attach images of private documents or of customers' details.`,
    `Do not use voice features to record other people without telling them: what the microphone records is sent to a speech-to-text service to be turned into text.`,
    `If Mink AI answers your customers, keep your store's information correct, give customers a way to reach a person, and do not tell customers they are talking to a person when they are not.`,
    `Do not use Mink AI to copy another business's look so closely that customers could confuse you with it, or to copy its words, photos or logos.`,
    `Do not try to make Mink AI act outside what you were shown and approved, get another store's data out of it, or make it produce code meant to defeat the limits it runs under. Automating or scripting these features to use up allowance beyond normal interactive use is a breach of this policy.`,
  ),

  section(
    "6. Shared infrastructure and fair use",
    `Our email sending reputation, rate limits and capacity are shared by every store. Behaviour that harms them for others, such as sustained abnormal load, mass automated requests, or sending patterns that lead providers to penalise us, may be limited or stopped even where no other rule in this policy is broken. Where a feature has a published limit, working around it is a breach. We may limit how often AI features can be used, to keep them working for everyone.`,
  ),

  section(
    "7. Intellectual property complaints",
    `Anyone who believes a store on ${COMPANY} is using their work, brand or listing without permission can write to <a href="mailto:support@storemink.com">support@storemink.com</a> with the store address, what they own, where it appears, and a statement that they are the rights holder or are allowed to act for them. We may remove or disable the content while we look into it, and we pass the complaint to the merchant so they can respond.`,
    `If we remove your content after a complaint, we tell you, and you can reply with your side. Complaints are handled by our Grievance Officer, within the times in section 9.`,
    `Repeated complaints against the same store that prove to be valid may end that account.`,
  ),

  section(
    "8. How we enforce it",
    `We may investigate suspected breaches of this policy. If you break it, we may remove content, suspend a store, switch off a feature, pause your WhatsApp or other messaging, or close an account.`,
    `Where practical and lawful, we will tell you what the problem is and give you a chance to fix it first. Where the risk to customers, to other merchants or to the platform is serious, we may act first and explain afterwards. We act without notice, within the time the law sets, when a court or government order requires it.`,
    `If you break these rules, we may remove content, or suspend or close your store, at once. Breaking the law may make you liable to a penalty or punishment under the Information Technology Act, 2000 or other laws. We may refer serious cases, such as fraud or harm to others, to the authorities, and where the law requires us to report an offence, for example under the Bharatiya Nagarik Suraksha Sanhita, 2023 or the Protection of Children from Sexual Offences Act, 2012, we report it.`,
  ),

  section(
    "9. Reporting a problem, and our Grievance Officer",
    `To report a store or content that breaches this policy, write to <a href="mailto:support@storemink.com">support@storemink.com</a> with the store address and what you have seen.`,
    `If you have a complaint about ${COMPANY}, about something published on a store built on ${COMPANY}, or about how we handle personal data, write to our Grievance Officer:`,
    `Anurag Goyal, Grievance Officer, STOREMINK LLP`,
    `Email: <a href="mailto:support@storemink.com">support@storemink.com</a>`,
    `Registered office: Faridkot, Punjab, India`,
    `Tell us who you are, how we can reach you, what the complaint is about, and the web address of the store or page it concerns.`,
    `We acknowledge every complaint within 24 hours and resolve it within 7 days. We resolve within 36 hours a request to remove content of a kind listed in section 2 of our Acceptable Use Policy, unless the only reason given is that the content belongs to someone else, infringes a patent, trademark, copyright or other right, or breaks any other law.`,
    `If content shows you, or a person you act for, fully or partly naked, with private parts exposed, or in any sexual act or conduct, or if it pretends to be you or that person, for example in a faked or morphed image, we remove it or block access to it within 2 hours of receiving your complaint. Write "Urgent" in the subject line so that we see it at once.`,
    `If you are not satisfied with our decision, or we do not resolve your complaint within these times, you can appeal to the Grievance Appellate Committee at gac.gov.in within 30 days.`,
  ),
].join("\n");

/**
 * The CURRENT source text of each policy, not "version 1".
 *
 * To change a published policy: edit the body above AND bump its `version`,
 * then run `scripts/publish-legal.ts --publish`. Bumping the number is what
 * tells the publisher this is a new version rather than a re-run; editing the
 * body without it does nothing, because the DB row is immutable once published
 * and the publisher refuses to go backwards or sideways.
 *
 * The old version stays in the table forever: people accepted it.
 *
 * ⚠ PUBLISHING v2 INTERRUPTS EVERY MERCHANT. The re-acceptance gate in the
 * dashboard layout holds them until they accept, so publish all three together
 * rather than three times.
 */
export const LEGAL_CONTENT: LegalContent[] = [
  // Terms v2, Privacy v4 and Acceptable Use v2 were reviewed and approved
  // together (owner, 26 Oct 2026) and go live together through migration
  // 20261026_0255_publish_legal_terms_v2_privacy_v4_aup_v2,
  // so every merchant re-accepts once. Privacy v3 stays in legal_documents
  // for the people who accepted it.
  { kind: "terms", title: "Terms of Service", version: 2, body: TERMS_BODY },
  { kind: "privacy", title: "Privacy Policy", version: 4, body: PRIVACY_BODY },
  {
    kind: "acceptable-use",
    title: "Acceptable Use Policy",
    version: 2,
    body: AUP_BODY,
  },
];
