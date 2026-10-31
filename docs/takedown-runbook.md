# Takedown runbook: complaints, orders, blocks and holds

> Operator-only. What to do, in order, when a complaint, a court or government
> order or a data request reaches StoreMink, and the by-hand steps the console
> cannot do. The screens are described in
> [`operator-console.md`](operator-console.md) ("Complaints, blocks and
> holds"), the alerts in [`monitoring.md`](monitoring.md) (25 to 28), the
> design in CODEBASE.md §5 convention 45. Nothing here belongs in the Help
> Centre: the merchant's side is the guide "If StoreMink blocks something on
> your store" (migration 0270).

Every complaint is handled in the storemink.com console, **Complaints**. Log it
the moment it arrives, with the time it reached StoreMink (the time on the
email, letter or order, in India time), never the time you log it: every
deadline counts from the received time, and the database refuses a deadline
later than the law allows.

## Who can do what

| Action                                                                      | Operator (member) | Superadmin |
| --------------------------------------------------------------------------- | ----------------- | ---------- |
| See complaints, blocks, holds and the record (not archived contents)        | yes               | yes        |
| Log, acknowledge, resolve or reopen a complaint; email the complainant      | yes               | yes        |
| Block an item, including at a store's own request                           | yes               | yes        |
| Keep a block from the store (court or government order only); tell it later | no                | yes        |
| Suspend a store on a complaint                                              | no                | yes        |
| Reply to a store; add a store's emailed reply                               | yes               | yes        |
| Retry a file now; mark a theme file as removed by hand                      | yes               | yes        |
| Lift a block (any block, a store-requested one too)                         | no                | yes        |
| Open or download an archived copy; keep it longer; set or release its hold  | no                | yes        |
| Put a store on hold; release it                                             | no                | yes        |

Members can block because the 2-hour rule runs at night and whoever is on the
rota must be able to act alone. Every action checks the role again on the
server; a hidden button is not the permission.

## The deadlines, by kind

| Kind                                            | Acknowledge | Remove, block or provide | Resolve         |
| ----------------------------------------------- | ----------- | ------------------------ | --------------- |
| Court order                                     | 24 hours    | 3 hours                  | 3 hours         |
| Government or police order to remove content    | 24 hours    | 3 hours                  | 3 hours         |
| Order to give information or help, rule 3(1)(j) | 24 hours    | 72 hours                 | 72 hours        |
| Intimate image or impersonation                 | 24 hours    | 2 hours, at any hour     | 36 hours        |
| Content listed in Acceptable Use section 2      | 24 hours    | 36 hours                 | 36 hours        |
| Other removal request                           | 24 hours    | 7 days                   | 7 days          |
| Other complaint                                 | 24 hours    | 7 days                   | 7 days          |
| Personal data request                           | 24 hours    | 10 working days          | 10 working days |

Ten working days skip Saturdays and Sundays but not public holidays, so the date
the console shows is never later than the promise. **Change kind** only ever
tightens a deadline: when a complaint logged as "Other complaint" turns out to be
about an intimate image, its deadlines move earlier, counted from when it reached
StoreMink, and a deadline already passed shows at once ("act now").

## The order of work for each kind

For every kind:

1. **Log a complaint** (`/dashboard/complaints/new`): when it reached us, how,
   what it is, who sent it and how to reach them, who they act for, the order or
   reference, the store and the web addresses, and what they ask for in your
   own words. Never paste an intimate image, a password or a card number. The
   line under the form shows the deadlines before you save.
2. **Send acknowledgement** within 24 hours when the contact is an email address
   (it gives the reference, SM-000123, a copy of the complaint as recorded and
   when it will be resolved), or **Mark as acknowledged** when you answered from
   the support mailbox. The received time can be corrected only before this.
3. **Act** by the middle deadline: **Block an item** from the complaint (the
   complaint is chosen, and the first block marks it actioned), or **No removal
   needed** with the reason. For an information order the button is
   **Information provided**, for a data request **Request answered**.
4. **Resolve** with the outcome (Removed, Partly removed, Not removed, Not on
   StoreMink, Withdrawn by them, Answered). Not removed and Partly removed need
   a note: the complainant can appeal to the Grievance Appellate Committee.
   Leave "Email the outcome" ticked when there is an email address.

Then, by kind:

- **Court order, government or police order** (3 hours): check the order first
  (below). Block every address it names, reason "Court order" or "Government or
  police order", with the order's number, date and the law it names as the legal
  basis. If the order says the store must not be told yet, a superadmin unticks
  **Tell the store** (below). Resolve "Removed" once every address is blocked.
- **Intimate image or impersonation** (2 hours, at any hour): block the item and
  leave its images ticked (they are ticked by default for this reason, so they
  stop loading everywhere they are used). If the picture is on more than one
  item, block each. Resolve within 36 hours.
- **Content listed in Acceptable Use section 2** (36 hours): read the item
  against section 2; block it if it breaks it, otherwise No removal needed with
  the reason. Resolve within 36 hours.
- **Other removal request, other complaint** (7 days): the same, with more time
  to ask the store. A block StoreMink makes on its own (no complaint) uses
  "Breaks our Acceptable Use Policy" and "No complaint: StoreMink found it".
- **Order to give information or help** (72 hours): see "Answering an order for
  information" below.
- **Personal data request** (10 working days): answer it from the support
  mailbox, then Request answered with how and to whom, then Resolve "Answered".
- **A store asks us to remove a review or a comment on its own store**: block
  that one review or comment with the reason "The store asked us to remove it"
  and "No complaint: the store asked us". Only a superadmin can lift it later.

When a whole store is the problem (unlawful goods, a store built around abuse,
repeated circumvention), a superadmin uses **Suspend on a complaint** on the
store's console page: see "Closing a store for misuse".

## The 2-hour path at night

Alert 25 ("Takedown: a complaint needs action") wakes the on-call operator when
an urgent complaint is logged and for a deadline 30 minutes away, and the
support mailbox wakes them for a new email (owner step P8). The console works
at phone width.

1. Open the email. If it is an intimate image or impersonation complaint, or a
   court or government order, **log it now** with the received time from the
   email, even before reading it all: the deadline already runs from that time.
2. **Block an item**: paste the address, press **Find**, check the card (the
   item, its store, "Now: Published", where it appears), leave the images ticked,
   pick the reason and press **Block now**. The item is hidden on the next
   request; a file's address is swapped on every page at once and in the image
   optimizer within 30 seconds. A member can do all of this alone.
3. Send the acknowledgement if you can; it may wait until morning (24 hours).
4. Leave the rest (asking the store, resolving) for the day.

## Before blocking on an order

Rule 3(1)(d)(ii) asks for a real order, so check, and write what you checked in
the complaint's summary:

- It is in writing, from a court, or from an authorised officer of the
  government or police (name, designation, office).
- It names the law it relies on (the legal basis) and gives its number and date.
- It names the exact address of each item (a store's web address or a file's
  address). Block exactly those; ask the sender when an address is missing or
  does not resolve, and note the question in the complaint.

**Keeping a block from the store** (the store sees nothing: no email, no notice,
no label, nothing in Mink AI) is for a court or government order that says the
store must not be told yet, and nothing else. Only a superadmin can untick
**Tell the store**, only with the court or government order reason and its legal
basis filled in. When the order allows, a superadmin presses **Tell the store
now** on the block's page; this cannot be undone.

## Answering an order for information

An order to give information or help is answered within 72 hours.

1. Log it (kind "Order to give information or help").
2. If the information is an item StoreMink blocked, a superadmin opens the
   block's archived copy (**Open the copy**, with the complaint reference as the
   reason), then **Download record** and **Download** each file the order asks
   for. Every opening and download is recorded with that reason.
3. **Keep longer** on that copy with "Until we release it" (or a date), and the
   authority and its reference under "Who asked", so the 180-day purge cannot
   take it while the matter is open.
4. Send what was asked to the address the order gives, from the support mailbox.
5. **Information provided** with what was sent and to whom, then Resolve
   "Answered".
6. When the authority confirms it no longer needs the copy, **Release hold**
   with a note.

If the order concerns a store as a whole (it may be deleted otherwise), a
superadmin also puts the store on hold (below).

## Holds

**Put on hold** (superadmin, on the store's console page) stops anyone deleting
the store, from the console or anywhere else (the database refuses it), while an
investigation needs it: a reason is required, with who asked, an optional
complaint and an optional review date. The store is not told. The Overview lists
holds whose review date has come ("Holds to review"). **Release hold** needs a
note. A hold also keeps the store's Mink AI chat pictures from the nightly
attachment purges; it pauses no other sweep in this release.

## Closing a store for misuse

1. A superadmin presses **Suspend on a complaint** on the store's page (or
   "Or suspend a whole store" on Block an item). The form names what happens:
   the storefront, the dashboard and the POS close on every address; StoreMink
   first keeps a copy of everything on the store, its Mink AI chats included.
2. Block any image that must stop loading at once as its own item: a store
   suspension hides the store's pages, but its files stay at their storage
   addresses until blocked.
3. Wait until the block's page shows **Store copy: Complete** ("Copying files: N
   of M" until then; the follow-up copies 50 files a minute). Until it is
   complete, Delete store is refused: "StoreMink is still keeping a copy of
   something blocked on this store. Try again in a few minutes."
4. Then **Delete store** on the store's page, if the store is to go. A store on
   hold cannot be deleted until the hold is released.

A store whose content is larger than 256 MiB cannot be suspended from the console
(its copy is built in memory): the form refuses, and you block the items that
cannot wait one by one. The plain **Suspend** button asks why, and "Because of a
complaint, an order, or content that breaks our policies" sends you to Suspend
on a complaint; use the plain one only for another reason, such as the owner
asking, with a note.

**A suspended store's owners** get the whole message by email (they cannot open
the dashboard). Their replies arrive at support@storemink.com: copy each into
the block's conversation with **Add the store's emailed reply**. The notice
joins the store's Notices from StoreMink once the store is reactivated.
Reactivating a store suspended by a block is done only by lifting the block.

## Files

- **Retry now** on a block's page (or the Files tab) makes a waiting copy or
  replacement due at once and resets its attempts; it writes no event of its
  own. Without it, the follow-up retries every minute with a backoff for 24
  hours, then leaves it "Copy failed, retry needed".
- **A file in StoreMink's bucket** is copied to the archive first, then replaced
  with the placeholder (an image) or deleted (any other file) about a minute
  after the block, never before its copy is confirmed.
- **An outside file** (another host, Unsplash included) is not StoreMink's:
  pages on this store stop showing it, but it stays at its own address. Ask
  whoever hosts it to remove it if needed. A picture still on StoreMink's old
  storage is handled this way too.
- **A theme image built into the app** (`/themes/...`) shows the placeholder on
  every store that uses it, at once. To remove the file itself:
  1. delete it under `public/themes/<theme>/`;
  2. change `lib/themes/definitions/<theme>.ts` so nothing names it (pick
     another image of that theme);
  3. deploy (dev, then main);
  4. press **Mark as removed** on the block's page, with a note. Only a theme
     file offers this button.
- **A theme release image** (`theme-releases/`) is shared by every store that
  installed that theme: blocking it replaces it on all of them. The console
  warns before you block.
- **Never test on a theme demo store**: its pictures are shared by every store
  on that theme. Theme Studio preview stores cannot be blocked at all.

### Putting a file back by hand

When a block on a theme file removed by hand is lifted, pages show the address
again, but the file is gone until you put it back: copy it from the archived
copy (superadmin, **Open the copy**, **Download** the file), restore it under
`public/themes/<theme>/` and in the theme definition, and deploy.

After a lift done in SQL (see "Code rollback" below), a bucket file left
`restoring` needs its original copied back by hand:

```bash
gcloud storage cp \
  gs://<private bucket>/takedown-archive/<DB_NAME>/<block id>/<n>-<file name> \
  gs://<public bucket>/<object path> \
  --cache-control="public, max-age=60"
```

The private bucket is `storemink-chat-media-prod` in production and
`storemink-chat-media` for staging and local; the public one is
`storemink-media-prod` or `storemink-media`. `<DB_NAME>` is the environment's
database (`storemink`, `storemink_staging`, `storemink_local`); never restore a
copy from another environment's folder. `<n>-<file name>` is the entry's name in
the archived copy's file list.

## Checking that a block reached every door

After blocking a file (replace the address and the store host):

```bash
# the image optimizer: 200, image/webp, cache-control no-store (the placeholder)
curl -sI "https://<store host>/_next/image?url=<encoded file address>&w=640&q=75"
# a theme file: the placeholder
curl -sI "https://<store host>/themes/<theme>/<file>"
# the share image: image/jpeg, no-store
curl -sI "https://<store host>/api/og-image?url=<encoded file address>"
# about a minute later, the raw storage address answers the placeholder bytes
curl -sI "https://storage.googleapis.com/<public bucket>/<object path>"
```

Pages show the placeholder at once. What still reaches someone who already holds
a raw storage address: the original until the replacement (about a minute, longer
while the copy waits), then a copy Google's storage cache took earlier until its
lifetime ends (60 seconds for objects written or relabelled after this release;
longer for an edge copy taken before production step P2). Browsers that already
loaded an image, share cards taken by social networks (up to a day) and image
optimizer copies made before the block (up to 4 hours) are outside StoreMink's
reach.

On dev and staging there is no scheduler: the follow-ups run at the end of each
console action and on Retry now, so a replacement (which waits 35 seconds after
the block) happens at the next action.

### If Cloud CDN is on (production step P1)

P1 (`gcloud compute backend-services describe storemink-prod-backend --global --project=storemink-prod --format="value(enableCDN,cdnPolicy.cacheMode)"`)
has not been recorded yet. Record the answer here. If it is `True`, after every
file block, for each of the store's hosts:

```bash
gcloud compute url-maps list --project=storemink-prod --format="value(name,defaultService)"
gcloud compute url-maps invalidate-cdn-cache <URL_MAP> --global --project=storemink-prod --host=<store host> --path="/_next/image*" --async
gcloud compute url-maps invalidate-cdn-cache <URL_MAP> --global --project=storemink-prod --host=<store host> --path="/api/og-image*" --async
```

## Search engines

Every block of a product, page, blog post or collection sends the item's
addresses to IndexNow, and the address answers the ordinary 404. Google drops it
on its next crawl. For an urgent case on a storemink.com address (a store's
subdomain), an operator with access to the Search Console property
`sc-domain:storemink.com` files a temporary removal of that exact address
(Search Console, Removals, New request, "Remove this URL only"). A custom domain
belongs to its merchant: StoreMink cannot file a removal for it. Checking that
the right operators can use the property is the owner's step P7.

## The Grievance Appellate Committee

A complainant who disagrees with StoreMink's decision can appeal to the
Grievance Appellate Committee. Log an order from the Committee as a complaint
("How did it reach us?": Grievance Appellate Committee), act on it by its
deadline, and
publish the compliance report on storemink.com as rule 3A(7) asks (the page is
the owner's step P7).

## Lifting a block

Only a superadmin lifts. The block's page asks why (the store sees it) and
whether to email the store (ticked; absent when the store was never told), and
offers to lift the item's image blocks too. The item shows again on the next
request if the store has it published; a replaced file is put back from the
archive (unless the store has since changed or deleted it); a suspended store
opens with the status it had. A lift is refused while the follow-up is replacing
that very file: try again in a minute. The archived copy stays until its date.

## When an alert arrives

| Alert                                            | What to do                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 25. Takedown: a complaint needs action           | Open the complaint named by `ref` in Complaints and do what is due ("The 2-hour path at night" above).                     |
| 26. Takedown: follow-ups failing                 | Logs Explorer, "moderation: follow-up failed": which step, which block. Retry now on that block once the cause is gone.    |
| 27. Takedown: follow-ups stopped                 | Cloud Scheduler, `storemink-send-emails`: enabled, and what its attempts answer. Nothing replaces or alerts until it runs. |
| 28. Cloud Scheduler attempt failed (send-emails) | One failed minute is covered by the next; if it lasts, 27 follows.                                                         |

Each is described in [`monitoring.md`](monitoring.md) with its filter and its
rollback. Alert 25 also fires the moment an urgent complaint (a court,
government or information order, or an intimate image or impersonation) is
logged: the console writes `moderation: complaint urgent` beside the bell and
the email every operator gets.

## Production steps (owner)

- **P2, the stored cache lifetime of existing files** (required, decision D4):
  with the owner's own login, from the repository root after `npm ci`, dry run
  first, keeping every CSV it writes:

  ```bash
  node scripts/storage-cache-control.mjs --bucket storemink-media --prefix stores/ --cache-control "public, max-age=60"
  node scripts/storage-cache-control.mjs --bucket storemink-media --prefix stores/ --cache-control "public, max-age=60" --commit
  node scripts/storage-cache-control.mjs --bucket storemink-media --prefix theme-releases/ --cache-control "public, max-age=60"
  node scripts/storage-cache-control.mjs --bucket storemink-media --prefix theme-releases/ --cache-control "public, max-age=60" --commit
  ```

  then the same four with `--bucket storemink-media-prod`. The script leaves
  takedown placeholders (they stay `no-store`) and any `no-store` or `private`
  object alone, and writes the whole CSV before it changes anything. Verify:
  each commit run ends "failed 0", and
  `gcloud storage objects describe gs://storemink-media-prod/<a path under stores/> --format="value(cache_control)"`
  prints `public, max-age=60`. Roll back with
  `node scripts/storage-cache-control.mjs --restore <that csv>`, then the same
  with `--commit` (it restores only objects nothing has changed since).

- **P4, the four alerts**, after the takedown release is deployed:
  `python3 -I scripts/prod-monitoring.py`, then
  `python3 -I scripts/prod-monitoring.py --apply --email <alert address>`; add
  a "Google Cloud console (mobile)" channel and an SMS channel to "Takedown: a
  complaint needs action", "Takedown: follow-ups failing" and "Takedown:
  follow-ups stopped", and send a test notification on each. Within ten minutes
  Metrics Explorer shows `logging/user/moderation_followups_ran` once a minute.
- **P8, the support mailbox wakes someone**: a forwarding rule or the mail app
  on each on-call phone, allowed through Do Not Disturb, tested at night with an
  ordinary subject. Until a public complaint form exists (decision D11), this is
  the only alarm for an emailed complaint.

## Code rollback after blocks exist

The schema stays (migrations are forward-only). Rolled-back code still hides
blocked rows from every public read and keeps a block-suspended store suspended,
but it has no console to lift with, no page swap and no optimizer interception.
A superadmin can lift in SQL; the trigger turns it into a full unblock, and the
CHECK makes the file state settle in the same statement:

```sql
update public.content_blocks
   set lifted_at = now(), lifted_by = '<email>', lift_note = '<why>',
       storage_state = case storage_state when 'replaced' then 'restoring'
                                          when 'pending' then 'cancelled'
                                          when 'failed' then 'cancelled'
                                          else storage_state end
 where id = '<block id>' and lifted_at is null;
insert into public.moderation_events (actor, action, block_id, store_id, detail)
values ('<email>', 'block_lifted', '<block id>', '<store id>', '{"via": "sql"}');
```

A file left `restoring` then needs the copy command above.

## A build whose migration stopped at its lock timeout

Migration `20261030_0269_content_takedown` takes its locks with a 1-second
timeout. On a busy moment it rolls back whole and the build fails before the
deploy; nothing is half applied. Re-run the same build (Cloud Build, Retry), at a
quieter time if it repeats, and check the migrate step's log shows 0269 and 0270
applied in that environment's ledger (dev migrates staging, main migrates
production).
