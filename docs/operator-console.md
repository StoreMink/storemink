# Operator console — the StoreMink admin at `storemink.com/dashboard`

> The console an operator uses to run the platform, as opposed to the dashboard
> a merchant uses to run their store. Served on the platform host only
> (`proxy.ts` rewrites `/dashboard/*` → `/platform/dashboard/*`), gated on
> `platform_admins`.

## Why this exists

The console grew one panel at a time and they all landed on the **home page**:
the store table, the pricing editor and the theme seeder were stacked on a
single scroll, under a metric row. Three consequences, all of them real:

- **"Reprice the Pro plan" was one mis-click from "look at a store".** Those are
  not the same kind of act and should not share a screen.
- **A store had no page of its own.** Everything an operator knew about a
  merchant came from one table row plus a history drawer, so answering "why is
  this merchant complaining?" meant opening their dashboard as them, or writing
  SQL against production.
- **The page grew whenever the platform did.** Every new capability had one
  obvious home, and it was the bottom of `page.tsx`.

## The information architecture

| Group              | Entry          | Path                                     | What it answers                                                                                                                           |
| ------------------ | -------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **OPERATIONS**     | Overview       | `/dashboard`                             | What needs someone right now?                                                                                                             |
|                    | Stores         | `/dashboard/stores`                      | The merchant estate (no demos/previews)                                                                                                   |
|                    | ↳ store detail | `/dashboard/stores/[id]`                 | Everything about ONE merchant                                                                                                             |
|                    | People         | `/dashboard/people`                      | Who can sign in to which store                                                                                                            |
|                    | Complaints     | `/dashboard/complaints`                  | Every complaint, order and data request with its deadlines, and every block and store hold                                                |
|                    | ↳ log one      | `/dashboard/complaints/new`              | Log a complaint the moment it arrives                                                                                                     |
|                    | ↳ complaint    | `/dashboard/complaints/[ref]`            | One complaint (`SM-000123`): deadlines, details, actions, its blocks, history                                                             |
|                    | ↳ block        | `/dashboard/complaints/block`            | Find an item, a file or a whole store and block it                                                                                        |
|                    | ↳ a block      | `/dashboard/complaints/blocks/[blockId]` | One block: the file's state, the archived copy, the conversation with the store, lifting                                                  |
|                    | Announcements  | `/dashboard/announcements`               | Tell merchants something _(phase 4)_                                                                                                      |
|                    | Logs           | `/dashboard/logs`                        | What happened, what broke _(phase 3)_                                                                                                     |
|                    | Mink AI        | `/dashboard/mink`                        | Are agent runs reliable and affordable?                                                                                                   |
| **ADMINISTRATION** | Help Centre    | `/dashboard/help`                        | Platform docs                                                                                                                             |
|                    | ↳ feedback     | `/dashboard/help/feedback`               | Which Help Centre Mink AI answers visitors rated, with the question, the answer and its guides                                            |
|                    | Themes         | `/dashboard/themes`                      | Catalog tab: the catalog + its live demo stores _(superadmin only)_                                                                       |
|                    | ↳ Theme Studio | `/dashboard/themes/studio`               | Theme Studio tab: every Studio theme by what it needs, New theme _(superadmin only)_                                                      |
|                    | Pricing        | `/dashboard/pricing`                     | What StoreMink charges                                                                                                                    |
|                    | Analytics      | `/dashboard/analytics`                   | Platform Analytics availability                                                                                                           |
|                    | Roles          | `/dashboard/roles`                       | The staff roles every store picks from                                                                                                    |
|                    | Operators      | `/dashboard/operators`                   | Who runs the platform                                                                                                                     |
|                    | Billing & tax  | `/dashboard/billing`                     | Whether StoreMink charges GST, its tax identity, a scheduled change, the monthly invoice list, and whether refunds are sent automatically |
|                    | ↳ Refunds      | `/dashboard/billing/refunds`             | What StoreMink owes merchants, what is on its way, and every credit note                                                                  |

Themes appears in the sidebar and the search only for superadmins; the Overview
shows superadmins a Theme Studio tile ("Theme Studio: 1 needs you, 2 ready to
publish.") that links to those filters.

**The split is by job**, the rule `app/dashboard/lib/permissions.ts` already
applies to the merchant nav. Operations is what an operator watches and acts on
daily; Administration is configured once and left alone. **Logs is deliberately
in Operations** — it is the first place anyone looks when something is wrong,
not a setting.

## Rules this console follows

### ★ The gate lives where the read is

`requireOperator()` (`app/platform/dashboard/(console)/require-operator.ts`) is
called by **every page**, not just the layout. A Next layout and its pages
render **concurrently**: a layout `redirect()` does not abort a page already
fetching — the same property that forces every storefront page to call
`requireStorefrontStore()` for itself (CODEBASE §3). These pages read every
store on the platform under `withService`, which **bypasses RLS**, so the gate
is the whole of the access control.

**⚠ The home page does NOT use it.** `requireOperator` redirects a non-operator
to `/dashboard`, which _is_ the home page — a signed-in non-operator would loop
forever. Home keeps its own "not authorized" branch with a way out.

### ★ Reads live in `lib/platform/`, not `app/actions/`

Every export of a `"use server"` file is a publicly reachable endpoint.
`loadStoreDetail` / `loadStorePeople` / `getPlatformInsights` are reads called
by server components that have already resolved the viewer, so exporting them
as actions would add public endpoints returning cross-tenant data for no
benefit. Same resolution as `lib/domains/reconcile.ts` (§30) and
`lib/retention/prune.ts` (§32): **core in `lib/`, gate at the entry point.**

### ★ One round trip, not fifteen

A store detail wants ~15 counts. Issued separately that is 15 × the ~46 ms round
trip to Cloud SQL in Mumbai (`docs/local-dev-performance.md`) — most of a second
before React starts. They are scalar subqueries in one statement, the shape
`getPlatformOverview` already used.

### ★ Never a secret, only a state

Channel cards show `connected / paused / not connected`. Gateway, carrier and
SMS credentials are encrypted at rest and write-only by design (§18, §35, §37);
an operator console is not a reason to widen that. `loadStorePeople` likewise
never returns `pin_hash`, `invite_token` or `reset_token` — each is a live
credential, and none of them answers an operator's question.

### ★ Effective plan, never the stored one

The gates read `effectivePlan(store)`, so the console must too. A lapsed timed
grant is stored as `pro` and **is free today**; showing only the stored plan is
how a support conversation starts wrong. The store detail shows both when they
disagree, and the SQL predicates behind the overview's plan mix mirror
`effectivePlan` exactly — if this screen counted stored plans while the gates
read effective ones, the console would report revenue the product is not
delivering.

### ★ Zero is rendered, never hidden

The overview's **Needs attention** block is ten queues (the four takedown queues
first: Complaints due, Store replies, Files to finish, Holds to review), each of
which is zero on a good day and each of which stays on screen at zero, greyed
out. A row that
disappears when clear teaches nobody what is being watched. Only a non-zero row
takes colour and becomes a link. This is §22's sidebar-badge rule — a hardcoded
"12" on Orders taught people to ignore the badges that moved.

### ★ A read failure says so

`getPlatformInsights` never throws; it returns `ok: false` and zeroes. This is
the screen someone opens when something is wrong, so a 500 is the worst
available behaviour — but **rendering zeroes as though they were the answer is
the second worst**, hence the banner.

### ★ Archived copies are superadmin-only, and every opening is recorded

What StoreMink kept when it blocked something (the item, its store, its files,
and for a whole store its Mink AI chats) holds personal data and evidence. A
member sees that a copy exists, its size and its dates, never its contents. A
superadmin presses **Open the copy** and must say why ("For which complaint or
authority?") before anything is read: the reason is recorded first
(`archive_viewed`), and that record is a receipt good for 10 minutes. Every
file view and download goes through `/api/platform/takedowns/<block>/files/<n>`
or `/record` carrying that receipt, and each one records its own event with the
same reason. A link older than ten minutes, or another operator's, answers 403
and reads nothing. Pictures open blurred until **Show**.

### ★ Suspend a store over its content only with Suspend on a complaint

**Suspend on a complaint** keeps the evidence and tells the owners: StoreMink
first copies everything on the store into the archive, then suspends it in the
same transaction as the block, and only lifting the block reactivates it. The
plain **Suspend** button asks why: "Because of a complaint, an order, or content
that breaks our policies" sends the operator to Suspend on a complaint; "For
another reason, for example the owner asked" needs a note. The order of work is
in [`takedown-runbook.md`](takedown-runbook.md).

### ★ Mink traces are useful without exposing conversations

`/dashboard/mink` reads cross-store run telemetry through
`lib/platform/mink-runs.ts` only after the page calls `requireOperator()`. It
shows status, store, model, tool names, steps, latency, retry count, token usage,
shadow credits/cost cohort, answer rating, redacted issue category and safe
error codes. It deliberately does **not** select or render prompts, answers,
tool arguments, tool results, provider state, thought signatures or model
reasoning. Free-form feedback is bounded and privacy-redacted before storage.
An operational inspector is not permission to read merchant conversations.

Unknown and interrupted usage is labelled `partial` or `unavailable`; a null
estimate is rendered as **Unknown**, never `$0`. Filters are URL-owned and the
table is capped at the 100 newest matching runs. The aggregate cards still use
the complete filtered interval, so narrowing by store, status or window changes
both the table and the operating picture. The cards also show the number of
currently invited stores and feedback totals, so support can correlate a poor
rating to a safe run ID without opening the merchant's conversation.

The same page has one superadmin-only global voice-model switch between Google
Chirp 3 and Sarvam Saaras v4. It writes the service-only
`mink_voice_settings` singleton, and every store's `/api/mink/voice` request
reads that row before transcription. There is no per-store override. A failed
settings read fails the request rather than silently using a different model.

Below it, **Image provider** (superadmins only) chooses who draws Theme
Studio's photos and the storefront redesign's page photos: **Google** (the
default) or **ElevenLabs** (GPT Image 2.5 Sunburst), and for ElevenLabs the
quality (**Low** or **Medium**) and the resolution (**1K** or **2K**). It
writes the service-only `image_generation_settings` singleton; there is no
per-store override. Chat images, Refine, storefront personalisation and the
redesign's product re-shoots are always drawn by Google. The choice applies to
the next run that starts drawing. ElevenLabs draws only when
`ELEVENLABS_API_KEY` is set on the service; the page warns when it is chosen
without the key, and Google goes on drawing until the key is there. A failed
settings read also means Google. A 1K picture is enlarged to fit the page, so
it looks softer than 2K. Most of a picture's cost on ElevenLabs comes from the
reference photo sent with it (measured 22 Nov 2026 at 1K: about 130 credits
with none, about 475 to 560 with one), and nearly every redesign photo carries
one; the quality setting moves the price little.

Mink AI is available in every store without operator enrollment. Store detail
has no Enable/Disable Mink control. Migration 0157 backfills existing stores
and automatically provisions the complete tool registry for future signups.
Staff permissions, credits, plan limits and exact human approvals apply.
`MINK_AI_ENABLED` remains the deployment-wide emergency shutdown.

### ★ Roles are platform data a store reads, never writes

`/dashboard/roles` (`roles-console.tsx`, `app/actions/platform-role-actions.ts`)
edits `platform_roles`, the ONE list of staff roles every store's Staff page
offers and every dashboard gate reads (`lib/roles/platform-roles.ts`). A
merchant cannot add a role; an operator can, and can change what an existing
role may view or manage. Three things are fixed and the console says so: the
five seeded roles cannot be deleted (and the database refuses to delete ANY
role an `admins` row still references — `admins.role` is a foreign key with
`ON DELETE RESTRICT`); the owner's map cannot be narrowed, because
`superadmin` bypasses the map in code; and the two register roles (Manager,
Cashier) keep an empty dashboard map — what they can do at the counter is the
code table in `lib/pos/permissions.ts`, and `pos_staff.role` is a two-value
check, so a third register role cannot be added. Superadmin-only to write, for
pricing's reason: a saved map reaches every holder on every store on their
next request. The People column counts holders across the platform, which is
what deleting would cost.

### ★ Theme Studio is superadmin data, not a superadmin write

`/dashboard/themes/studio` (`lib/theme-studio/`) is the one console area a
platform **member** cannot even read. Studio prompts, reference screenshots and
generated drafts are superadmin-only, so every page shows a member a notice
instead of data, and every action and route re-derives a superadmin actor from
the session (`getThemeStudioActor`) before touching anything. Reference images
are stored sanitized in Postgres and served only through a gated, no-store
route. Full record: `docs/mink-ai-theme-studio-phase2.md`.

Since TS-2 (25 Oct 2026) Theme Studio is three screens: **Themes** with its
Catalog and Theme Studio tabs, **New theme**, and one page per theme. The Themes
entry in the console's sidebar and search is shown to superadmins only.

**Themes** has two tabs. **Catalog** is the demo-store panel: open a theme's
demo store, or seed or reseed it (the result is a note on its row). **Theme
Studio** lists every Studio theme with its catalogue card, its status in words,
when it last changed (or how long it has been working) and one button; filter by
All, Needs you, Building, Ready (ready to publish), Live and Archived. The model
and the creator are on the theme's Log tab, not the list. A button never acts by
itself: it opens the live demo, New theme, or the theme page at that action's
dialog. **New theme** takes a name (the ID is derived from it; change it under
**(change)**), a brief, up to 10 screenshots (JPEG, PNG, WebP or AVIF, 10 MB
each and 40 MB in all, checked as you drop, paste or choose them, before
anything is created) and 1 to 5 industries, one picked from the brief for you.
Catalogue size, must-have features, a starting theme (StoreMink's own themes
only) and the model sit under **More options**. The heading says how long a
build usually takes, from the last 10 finished builds (35 to 75 minutes until
there are 10). **Create and start** creates the theme, adds the screenshots with
each one's progress and starts the build. If the build can't start (building or
the model switched off, your 2 running builds, the daily spend cap, a stale
page), you land on the theme as **Not started** with the reason shown and the
brief and screenshots kept; nothing is created twice. With building switched off
the button reads **Create (building is switched off)** and only creates. **Start
a new theme from this brief** opens New theme filled in from that theme's brief.

A theme's status is one phrase with one main button, the same on the list, the
theme page and the Design list: **Live, v1.0.0** or **Not offered to new
stores**; **Publishing**; **Publish didn't finish** with its first reason (**Try
again**); **Removed from list**; **Waiting to start**, **Building: drawing
pictures (26 min)**, **Checking on today's StoreMink build**, **Checking
pictures** or **Checking your change**; **Stuck since 10:40** after 20 minutes
with nothing new (**Stop and check again**); **Needs your answer**; **Needs a
new start: too many questions**; **Can't publish: security problem**;
**Stopped**; **Needs a StoreMink fix**; **Couldn't finish the checks** with its
reason; **Pictures missing (3)**; **Needs a fix (2 problems)**; **Ready to
publish**, with its warnings; **Ready to publish (StoreMink was updated)**;
**Couldn't finish** with its reason; **Not started**; **Your change didn't
finish** with its reason (a change from the chat that stopped, on a theme that
kept its design); **Not checked yet**. (Times and counts are examples.) When building or the automatic checks are
switched off, the phrase says so and no main button shows.

Open a theme and choose **Delete** in its **...** menu to remove the theme, its
chat, screenshots, designs, private previews and its published release. This
also works for a theme removed from the list. Type the exact theme ID shown in
the confirmation dialog. Deletion cannot be undone. Stop any work first; a theme
installed by a merchant store cannot be deleted until that store switches
themes. If another project shares a published theme's ID, delete that other
project first. Theme-owned demo stores are removed with released themes. A
minimal deletion receipt remains for audit; shared published images remain
because stores may reuse them in saved content. To recreate a deleted design,
enter the same theme name and ID (under **(change)**) in **New theme**. Studio
keeps the name and automatically assigns an available ID such as `bubble-2`. The
theme's Log tab shows the assigned ID. Deleted IDs stay reserved so old release
links cannot point to a different design. An ID used by an active project still
needs to be changed manually. Bundled themes are code-owned and cannot be
deleted from Theme Studio.

**The theme page** (`/dashboard/themes/studio/<id>`) is one full-width page: the
console sidebar steps aside while it is open, the chat is on the left and the
tabs **Preview**, **Checks**, **Pictures**, **Changes** and **Log** are on the
right. Fold the chat to a slim rail with **Fold the chat** beside its heading,
or drag its edge (or focus it and use the arrow keys) to change its width; this
browser remembers both. The header shows the theme's status in plain words and
its one main button; **Design N** lists every design (its number is the version
number) to show it, make it current or change it; the **...** menu holds
**Stop**, **Remove from list (keeps its history)** (never on a live theme) and
**Delete**, each behind a dialog, and Remove and Delete wait, with the reason
under them, while Theme Studio works. The address keeps the open tab and design
(`?tab=checks&version=<id>`); a link with `do=<action>` opens that action's
dialog or moves to its button and never starts work by itself. The old addresses
(`/versions/<id>`, `/acceptance`, `/images`, `/compare`, `/release`) open the
matching tab. While Theme Studio works, the chat ends with a progress card: each
step by name with its time (a repair round is its own row; a "next try at" time
appears only when a step waits for one), how long a build usually takes, and the
AI's plan (what it assumed and what it left out). The page asks a small progress
route every 3 seconds, slowing down while nothing changes, and reloads only when
the theme itself changes; you can leave it, and the operator who started the
theme gets a notice and an email when it is ready or needs them.

**Start building** sends the first brief, with the screenshots New theme added.
After a design exists, describe a change and attach screenshots with
**Screenshots**, paste or drag and drop (up to 10 per message, 40 MB in total,
10 MB each); **Screenshots** also lists earlier screenshots to attach again and
deletes an upload no message has used (a theme keeps up to 100 screenshots / 400
MB). A change goes to the design you are looking at unless you pick another
under **Changing**, and each makes a new design. Answers to the AI's questions
continue the same request and can include fresh screenshots. **Stop** says what
is kept: a capture or the design review stops at once, a build step within a few
seconds, and pictures already drawn are saved and reused by **Continue
building**. The theme goes back to its last design; a first build stopped before
its first design shows as **Stopped**, and **Continue building** starts it
again. Work with nothing new for 20 minutes offers **Stop and check again**, one
dialog that stops it and then checks the current design again. **Check again**
measures the current design on today's StoreMink build with its design review,
in about 3 to 5 minutes; nothing is redrawn. A theme whose security check failed
takes a change in the chat straight away. The runs (with **Cancel** behind a
confirm, and **Retry**), their codes, tokens and costs, Activity in plain words,
the model and the creator are in the **Log** tab, and every stopped step says
why in a sentence. On a phone the page scrolls as one column (the header scrolls
away, the tabs stay at the top), the chat is a tab of its own that keeps the
screen's height, the preview fits the screen's height, lists open as bottom
sheets, and a bar at the bottom shows the status while Theme Studio works and
**Publish** when the theme is ready (held back, with the reason under it, when
Publish has to wait; it hides while you type). While nothing can be sent, the
message box folds to the sentence that says why.

Internal drafts remain hidden while layout checks run before artwork, then Theme
Studio draws missing images, captures the storefront and runs full acceptance.
Settings defects receive focused repairs; image defects redraw only the named
generated slots. Mixed findings repair settings first. Renderer defects stop
with a platform diagnosis. A repair that repeats or worsens the same findings
stops early; up to three improving repair rounds are allowed. The Checks tab's
Technical details show the diagnosis and the exact repair targets ("The
automatic fixes"). Visual review runs after deterministic checks pass. Only
serious findings are repaired or stop a theme ("Fix it, then allow Publish"):
broken or unthemed pages, unreadable text whatever its cause, broken links,
security, broken or unchecked pictures, invented claims, unfinished shop,
product or cart views, copied work, very low design-review scores, and anything
that could not be checked. Smaller findings and taste left after the repairs are
warnings you may publish past. A successful result is **Ready to publish**, with
saved check evidence and its design review; one Publish takes it live, with no
second person. Runtime faults, serious findings left after the repairs, or a
Stop keep the draft and say why in a sentence, with the next step (**Needs a
fix**, **Couldn't finish the checks**, **Stopped** and so on); they are not
reported as successful themes. Only a serious finding left after the repairs
asks you to describe a fix in the chat; checks that could not finish, or
StoreMink's preview not working, read **Couldn't finish the checks** and offer
**Check again**, since no change to the theme can help. The list, the theme page
and the Design list all read the newest result of the checks, so a design that
passed once and then stopped on **Check again** says so everywhere, and the
Checks tab says why. A design no check has judged reads **Not checked yet**. A
change from the chat that stopped reads **Your change didn't finish** with its
reason, with **Try again** and **Check again** (the design it kept is still the
current one). A picture run that failed shows **Drawing pictures didn't finish**
with **Retry** until you start something else (Check again, Make current or a
change); after that it stays in the Log tab. Performance remains advisory.

Since Phase 3 a run can call a paid Gemini model on Vertex AI. Each run's tokens
and estimated cost are in the Log tab, and a per-operator ceiling on estimated
spend in any 24 hours refuses new runs once reached (50 dollars in production
since the Theme Studio release: "You have reached today's Theme Studio spending
limit. Try again tomorrow."; a build already running is never stopped). The
operator who started a theme gets an in-app notice and an email when it is ready
to publish, needs a fix, or has questions; other operators are not told. New v21
builds choose a direction, palette family and native styles explicitly. When a
design still looks like a theme already in the catalogue, the Checks tab says so
with its distinctness and the threshold: a warning that calls for a look at the
composition and never stops Publish. References take priority over novelty.
Image updates retain the comparison, and older versions have no score.

A model that asks for details leaves the theme at **Needs your answer** until
you answer in the chat, or make another design current, which sets the questions
aside. A theme stopped by its security check (**Can't publish: security
problem**) has no questions open and can be changed straight away. Images start
as marked placeholders until Theme Studio draws them or an operator uploads
them, and a design with a placeholder left cannot be published. Record:
`docs/mink-ai-theme-studio-phase3.md`.

**Emergency switches** (superadmin operations, on the web service's
environment; see `CODEBASE.md` §7 and `docs/mink-ai-theme-studio-phase6.md`
§9): `THEME_STUDIO_GENERATION_ENABLED=false` stops new Studio runs, and
`THEME_STUDIO_DISABLED_MODELS` switches off one model without a build. Turning
off `gemini-3.8-flash` also turns off the per-photo check that merchant
storefront redesigns share. The next deploy replaces the environment, so a
switch that must last goes into `cloudbuild.yaml`.

Each design opens in the theme page's **Preview** tab: a private store built
from that design and rendered by the live storefront, at Desktop, Tablet or
Phone size, fitted to the tab's width and height (it opens at Tablet in a box
narrower than about 900 px and at Phone in one narrower than 600 px); **Open
full page** opens it in a new window at once. The preview stays loaded while
another tab is open. It takes no orders, is hidden from search and from the
Stores list and overview counts, and is removed a day after it was last opened.
A design can be **changed** from the chat (changing an older one starts a
branch), **compared** with the design it came from in the **Changes** tab, and
**made current** again from the header's **Design N** list. With automatic
checks on, Make current never leaves a theme stuck. A design that passed is
**Ready to publish** at once when its checks and design review still hold on
today's StoreMink build; otherwise it is checked again in place (about 3 to 5
minutes, nothing redrawn). A design that never passed is checked on a new hidden
version. One with a placeholder left reads **Pictures missing**. A design still
inside a check cannot be made current. Record:
`docs/mink-ai-theme-studio-phase4.md`.

The **Checks** tab starts with what the checks covered (the pages, the widths,
the header panels opened on the home page, and the cart checked empty), then
**Must fix before publishing**, **Warnings (you can still publish)** and
**Passed** (Show all), each in a plain sentence with where it was found. Checks
that stopped before they finished never count as passed. **Check again**
measures the current design on today's StoreMink build with its design review,
in about 3 to 5 minutes; nothing is redrawn. Each serious problem gets its own
next step. A theme setting or security problem gets **Describe a fix**, which
puts a short summary of the serious problems (never the warnings) in the chat
for you to read, change and send; it never sends. A picture gets **Redraw**, for
exactly those pictures, after a small confirm. A fault in StoreMink's own shared
storefront code gets no fix button: it says StoreMink has been told and offers
**Copy details for an engineer** (we fix those in our code; the label never
makes a serious finding a warning). A design-review matter of taste offers
**Describe a change**, which opens the chat. A security failure blocks the
theme, warnings never stop it, and placeholder pictures fail the checks until
they are drawn or uploaded. **Screenshots** shows the newest final check's
pictures one width at a time; nothing loads until you open it, and a picture
opens full size in a viewer you move through with the arrow keys or a swipe.
**Technical details** holds the codes, the build, the design review's state, the
AI's assumptions, the automatic fixes, earlier runs, **Copy details** and, as a
fallback while Check again is new, the in-browser runner (keep the tab open and
visible; its result never publishes without a design review of its own). Record:
`docs/mink-ai-theme-studio-phase5.md`.

The **Pictures** tab keeps the catalogue pictures apart from the artwork. Every
final check takes the catalogue card and the desktop and phone screenshots from
the design's preview store, so there is no button to capture them; where the
browser job is switched off, upload them in the picture list. **What the
pictures need** offers **Redraw** for exactly the pictures the checks flagged (a
missing, too small or wrongly stored picture, a photo with a hard problem or one
not checked yet; when nothing is serious, the photos flagged for something
small), **Draw missing pictures** for the placeholders and **Retry** for a
picture run that stopped. Each is one click and a small confirm that names how
many and what it may cost at list price. For a design whose checks did not pass,
**Check again** measures it again. A capture the job never starts is stopped
after 15 minutes, and the theme returns to its last design. A category with no
image slot counts as a missing picture, but drawing cannot fill a slot the
design never declared: change that design in the chat to add its category
imagery. Full automatic-QA recovery requires the repaired web service and
capture job; see `docs/theme-studio-reliability.md`.

Below them, the Pictures tab lists every picture of the design shown, with where
it appears, what the image model is asked for and how it came to be. Upload a
replacement (cropped to the slot's shape and compressed to storefront limits),
say whether it is yours or licensed, and save the staged pictures as one new
design; a reload with unsaved uploads asks first. Tick drawn pictures or
placeholders to redraw them. With automatic checks on, a save whose pictures are
complete is checked before it is shown: one capture of the storefront (fresh
catalogue pictures, every page measured on today's build) and the design review,
never a paid redesign. The theme then returns to Ready to publish, or shows the
new design with the reason. A picture saved with no alt text takes its slot's
own description; the licence note is always yours to write. Picture runs you
start (Draw missing pictures, Redraw, Retry) are checked the same way once their
pictures are complete, and only runs an operator started count toward the
two-at-once limit. Changes keep those pictures. Record:
`docs/mink-ai-theme-studio-slot-images.md`. The **Changes** tab compares the
design shown with the design it was made from, past the automatic fixes' drafts.
The **Log** tab holds the runs with their codes, tokens and costs, Publish
history with each attempt's reasons, the catalog audit, the model, the creator
and today's build.

A theme that is **Ready to publish** (its automatic checks left no serious
finding and its design review passed) shows **Publish** in the theme page's
header, and in the bar at the bottom on a phone. One superadmin publishes; there
is no separate human scorecard or approval step, and no second person. The
dialog names the design and when it was made, says where it goes live (the theme
catalog on themes.storemink.com and every store's Theme library, with a live
demo store; stores that install it keep that exact version) and lists the
warnings that go live with it. If you are looking at another design, it says
which design will go live and opens the Design list so you can make yours
current first (on **Try again** it only says which design the attempt started
with: no design can be made current until that publish finishes). When Publish
has to wait (the theme file refuses it, or no re-check can start), the reason
is written under the button, and neither the list's Publish nor the phone bar's
opens the dialog. If StoreMink was updated since the checks, or the newest check
has no design review of its own, the button reads **Re-check now**: the design
is checked again on today's build first (about 3 to 5 minutes; you can leave the
page, and the operator who started the theme is told when it is ready to
publish). The warnings a theme carries are recorded with the publish. While it
publishes, the header shows each step. Publishing:

1. copies its images to permanent public storage;
2. stores an immutable release;
3. seeds and renders its demo store;
4. only then adds it to the public catalog and every store's Theme library.

A publish that did not finish stays hidden and shows **Publish didn't finish**
with its last reasons beside **Try again**, which resumes the same release
(after a StoreMink update it checks the design again first). A live theme shows
**Open live demo**, **Stop offering this theme** (it also leaves the Theme
library of every store that has not installed it) or **Offer again**, each
behind a dialog, and **Start a new theme from this brief**, because live themes
can't be changed yet. Each change is written to an audit (in the Log tab), and a
store that already installed the theme keeps its exact version. ⚠ Until the live
design-review benchmark has passed after the TS-1 release (plan step A2), nobody
presses Publish or Check again on an existing production theme. Record:
`docs/mink-ai-theme-studio-phase6.md`.

### ★ Billing & tax: StoreMink's own GST

`/dashboard/billing` decides what StoreMink's own invoices say (plans, extra
locations and Mink credit packs) and whether they charge GST. It is StoreMink's
tax identity, not a merchant's. **Every member reads the page; only a
superadmin saves, schedules, cancels or downloads.** Actions:
`app/actions/platform.ts` (`saveTaxIdentitySettings`, `scheduleGstChange`,
`cancelGstChange`, `exportInvoiceList` for a superadmin; `getTaxSettings`,
`getGstChangePreview`, `getGstChangeNotices` for any operator). Every sentence
on these cards comes from `lib/billing/tax-copy.ts`. The release ships with GST
**off**.

The cards, top to bottom, under the reconciliation and refunds banners:

1. **GST status** (`tax-status.tsx`). One sentence from the terms in force now
   ("No GST is being charged. Invoices show no GST.", "GST is being charged at
   18%, added to every price: plans, extra locations and Mink credit packs.",
   or the same with "From {date, time IST}: ..." for a scheduled change).
   Under it, whatever the state, while the LLPIN or the registered office is
   blank: "Invoices don't show the LLP's particulars yet. The LLP Act asks for
   the LLPIN and the registered office on every invoice. Add them under
   StoreMink's tax identity." With a change scheduled, **Cancel this change**
   asks "Cancel the change scheduled for {date}? If you sent merchants a notice,
   tell them it won't happen." A change that started while the page was open is
   refused and the card shows the started state; to stop charging after the
   start, choose Don't charge GST under Charging GST.
2. **StoreMink's tax identity** (`tax-identity-form.tsx`, **Save tax
   identity**): registered legal name ("STOREMINK LLP"), GSTIN (its first two
   digits must match the state), state, the address printed on invoices with a
   6-digit PIN, the SAC code (6 digits, from the accountant), the LLPIN
   (`AAA-0000`), the registered office (**Use the address above** copies the
   address into it), and the invoice number prefix (1 or 2 letters or digits;
   changing it does not renumber existing invoices). While GST is on or
   scheduled, none of these can be cleared, and an LLPIN needs a legal name.
3. **Charging GST** (`tax-change-form.tsx`): Don't charge GST or Charge GST,
   the rate (18% for StoreMink's services), prices that include or exclude GST
   (each with the live Basic monthly price worked out), and **Now** or **From a
   date and time** (in IST). The button reads Switch GST on now, Schedule this
   change or Save.
   - **The notice rule.** A change that raises what merchants pay (switching GST
     on with prices that exclude it, or a higher rate under them) cannot start
     "Now". It needs the **Notice email** select: one option per Operational
     announcement that has finished sending, newest first, with its delivered
     and failed counts; one that does not count is listed but disabled, with
     why in brackets (product news, not sent yet, nothing delivered, not by
     email, only some store owners). A notice counts when it is Operational,
     sent or partly sent with at least one email delivered, by email, to every
     store owner with no plan, status, age or launch filter (demo stores may be
     left out). The start must be at least **1 calendar month** after it went
     out, in India time, at least 5 minutes ahead and at most 400 days ahead.
     The server reads the notice itself, in the same transaction as the save.
     ⚠ A notice that only partly sent still counts (the coordinator's decision,
     the owner's to change): the owners whose email failed got none, so resend
     to them before the start if it matters.
   - **The impact panel** ("What this changes for merchants with a plan",
     `lib/billing/gst-impact.ts`) appears for any change that switches GST on or
     raises what merchants pay. It prices every renewing store's next renewal
     today and after the change with the renewal run's own arithmetic, and
     lists, each only when above 0: how many renewals cost more; how many of
     those are charged automatically today and will need paying by hand (above
     the merchant's autopay limit, or above ₹15,000, the most that can be
     charged automatically); how many stores have no state on record (their
     invoices would use StoreMink's state and name none for them); how many
     have a state read from a typed address; and how many are outside India
     (while GST is charged they cannot make new payments, and their renewals
     are charged IGST). The table keeps at most 200 rows, those needing
     attention first; a failed read says "Couldn't work out what this changes.
     Please try again." and never shows an empty table. Before scheduling with
     stores that have no state or are outside India, it asks again: Schedule
     anyway or Go back. The preview is rate-limited to 30 a minute per operator.
4. **Monthly invoice list** (`invoice-list-card.tsx`, a superadmin's alone: a
   member sees no card). Every invoice and credit note StoreMink issued in one
   India-time month, with GSTINs, place of supply, SAC and the GST split, for
   the accountant's GST returns. **Download CSV** saves
   `storemink-invoices-YYYY-MM.csv`; a month above 50,000 rows answers "This
   month has more invoices than one download can hold. Ask an engineer to
   export it in parts." rather than a cut file.
5. **Refunds** (`refund-settings.tsx`): the **Send refunds automatically**
   switch (below).

**A settings read that fails is never drawn as "GST off".** The status card
says "Couldn't read the billing and tax settings, so nothing on this page can
be saved. Refresh the page to try again." and every save on the page is
disabled until a read succeeds, because the cards would otherwise hold blank
defaults and a save would write them over StoreMink's stored identity.

The three saves bust the public pricing pages' cached GST terms after they
commit (`platform-tax`, at most 5 minutes stale before), and the hourly billing
run promotes a scheduled change when it starts (docs/cron-jobs.md).

**The notice email** (Announcements, category **Operational notice**, which
reaches every store owner whatever their marketing choice; channel email, SMS
only in addition; audience Store owners with no plan, status, age or launch
filter; demo stores excluded). Required, at least 1 calendar month before the
start, for prices that exclude GST; recommended for prices that include them,
because it asks merchants for their state. Fill in the start date and the live
prices from Pricing, with GST at 18% (the figures below are the design's
example: Basic ₹1,500, Pro ₹2,400 and an extra location ₹1,000 a month):

> Subject: GST will be added to StoreMink prices from {1 December 2026}
>
> From {1 December 2026}, StoreMink will add GST at 18% to the prices of its
> plans, extra locations and Mink credit packs, because STOREMINK LLP is
> registered for GST. Your plan's features don't change.
>
> What you pay from then:
>
> - Basic: ₹1,500 plus ₹270 GST, ₹1,770 a month; or ₹15,000 plus ₹2,700 GST,
>   ₹17,700 a year.
> - Pro: ₹2,400 plus ₹432 GST, ₹2,832 a month; or ₹24,000 plus ₹4,320 GST,
>   ₹28,320 a year.
> - Each extra location: ₹1,000 plus ₹180 GST, ₹1,180 a month; or ₹10,000 plus
>   ₹1,800 GST, ₹11,800 a year.
> - Mink credit packs: the pack price plus 18% GST.
>
> The new amount applies from your first renewal invoiced on or after {1
> December 2026}. Anything you have already paid for stays as it is.
>
> If you pay yearly for Basic, your renewal will be above ₹15,000, the most
> that can be charged automatically, so we will email you an invoice to pay
> instead. The same happens if your renewal goes above the autopay limit you
> approved. Plans & Billing shows your next renewal and how it will be paid.
>
> Your invoices will show your state, as the GST rules require. Please check it
> under Plans & Billing, Billing details, before your renewal. If your business
> is registered for GST, add your GSTIN there too: it then appears on your
> invoice and you can claim the GST as input tax credit. If your business is
> outside India, choose your country there instead.
>
> If you would rather not continue, you can cancel your plan in Plans & Billing
> before your renewal.

CTA label: **Open Plans & Billing**. With prices that include GST, a shorter
note: "From {date}, StoreMink's prices include GST at 18%, and your invoices
show it. What you pay does not change. Your invoices will show your state, so
please check it under Plans & Billing, Billing details, and add your GSTIN
there to claim the GST as input tax credit." An email cannot be unsent: if the
change is later cancelled, send a short follow-up.

**Switching GST on** (the owner's production steps; none is run by the build):

1. **Before the merge**, read production's GST state with the read-only checks
   in `docs/billing-architecture.md` §7 ("GST release: checks around the
   deploy"). Expected: GST off, prefix SM, no invoice charging GST.
2. **Deploy** (dev, then main); check both ledgers show 0266, 0267 and 0268.
   With GST off the migrate step prints no "left NOT VALID" notice. If GST was
   already on, save the full identity in one save as soon as only the new
   revision serves.
3. **Enter the identity with GST still off**: legal name STOREMINK LLP, the
   GSTIN, Punjab (03), the address and PIN as on the GST registration, the
   accountant's SAC code, LLPIN ADC-5432, the registered office, prefix SM.
   Check the status still says no GST is charged, the LLP warning is gone, and
   the next invoice prints the LLP line.
4. **Send the notice** above (required for prices that exclude GST, a month
   ahead).
5. **Schedule the change** after reading the impact panel: Charge GST, 18%,
   the price mode, a date on or after the registration takes effect (or Now for
   prices that include GST), and the notice. Contact the stores with no state
   if there are many. Within 5 minutes the pricing page shows the GST line; a
   test store's Plans & Billing shows the notice banner (prices that exclude
   GST) or "including GST" (once started).
6. **After the start**, check one of each end to end in a test store: a credit
   pack (the amount shown, the amount Razorpay asks and the invoice total
   agree) and the first renewal invoice issued after the start (a Tax invoice
   with the GSTIN, SAC, place of supply and reverse charge line). The counts of
   `billing.renewal_place_of_supply_fallback` and `billing.renewal_outside_india`
   in the logs should match what the impact panel listed (each is a store to
   contact); no `billing.issue_kept_draft_tax` or `billing.renewal_tax_snapshot`
   should appear. At the month's end, download the monthly invoice list and
   check one line against its invoice.
7. **Apply the two GST alerts** (docs/monitoring.md, 23 and 24).

Switching GST off after the start is possible but must agree with the
registration: ask the accountant first.

### ★ Refunds, credit notes and a store's billing tools

StoreMink refunds a merchant's renewal when the plan ends before the cycle it
paid for (they cancelled, or a downgrade closed the invoice and a payment landed
anyway), and an operator refunds for the reasons the Terms promise. The pass
that owes, sends and settles those refunds runs in the hourly billing job
(`docs/cron-jobs.md`, `lib/billing/refunds.ts`); these screens are where a
person takes over. Actions: `app/actions/platform-billing.ts`. **Every member
reads every screen; only a superadmin sends, cancels, retries, records, issues
a refund, or cancels or ends a plan**, and all of those but Send ask for a
note.

**Refunds** (`/dashboard/billing/refunds`, from Billing & tax) has four tabs:

- **Needs a person**: a failed refund with no later refund of that payment, a
  refund owed or sent more than a day ago, or one held while automatic sending
  is off. The tab's count is the Billing & tax banner's, 0 included.
- **In progress**: every owed or sent refund. **Done**: processed, recorded and
  cancelled refunds.
- **Credit notes**: every store's notes, newest first, each with a Print link to
  `/dashboard/billing/credit-notes/[id]`. That page calls `requireOperator()`
  before it reads, because its reader has no store predicate (it prints a
  deleted store's note too).

On an **owed** refund: **Send** (sends it now through StoreMink's Razorpay
account), **Cancel** (says why; nothing is sent and the merchant is not
emailed, so write to them), and **Record a refund made outside StoreMink**. On a
**failed** refund: **Try again** (a new refund with the same reason; the
automatic one is never retried by the pass) and **Record**. Record takes the
method (bank transfer with its UTR, or a Razorpay refund made in the Razorpay
dashboard with its refund id), the amount and a note, and issues the credit
note and the merchant's email like any finished refund. Record a refund made by
hand in Razorpay the same day, so the records and credit notes match. A row
whose store was deleted says "Deleted store"; its email goes to the billing
email recorded on the invoice. ⚠ An empty tab and a list that failed to load
look the same; the count above the tabs says when it could not be read.

**Billing & tax** shows "**{n} refunds** need a look." with Review when any
wait, a quiet "Refunds and credit notes" link at zero, and the link with a
sentence when the count could not be read, never a zero. Its **Send refunds
automatically** switch is its own Refunds card (`refund-settings.tsx`) below
the GST cards, saves on change and is a superadmin's (a member sees it
disabled; it is disabled for everyone while the settings could not be read).
A save that meets an incomplete tax identity (possible only while GST is on)
says to save StoreMink's tax identity first. It ships **off**: refunds the billing job owes wait as owed until someone
presses Send. Turning it on lets the job send them itself; refunds an operator
issues are always sent at once.

**The store page** (`/dashboard/stores/[id]`) shows, to everyone, a cancelling
line (who asked: the merchant, or the operator's email), the next invoice and
its status, and the store's recent refunds and credit notes. A superadmin also
gets four tools:

- **Cancel at the end of the cycle**, only on the merchant's written request:
  they keep the plan until the cycle ends, autopay stops at once, and a renewal
  already paid for the next cycle is owed back when the plan ends (sent by the
  billing job while automatic sending is on, otherwise by your Send). The
  merchant is told "after your plan ends, usually within 5 working days".
- **Undo cancellation**: their plan continues; autopay stays off until they set
  it up again.
- **End the plan now** (declined terms, a removed feature, or another reason):
  ends the plan at once, revokes autopay, closes any open POS shift and closes
  the invoices for cycles the plan will not reach. With **refund the unused
  part** ticked it refunds the rest of the current cycle from the date given
  (required for a removed feature: the day it was removed), showing the
  server's own figure before you confirm. A part under ₹1 is skipped and named;
  a refund that fails never undoes the end.
- **Issue a refund**: one refund of one payment of an issued invoice, with a
  reason and an amount (at least ₹1, at most what is left on that payment).
  "Plan ended before this cycle" fits only an invoice for a cycle the plan did
  not reach. `?refund=<invoiceId>` opens it for that invoice.

**Set plan cannot lower a plan a merchant pays for by subscription**: it refuses
anything below the live subscription's plan and points to Cancel at the end of
the cycle or End the plan now. Equal or higher, or any plan once the
subscription has ended, still works.

**The reconciliation queue** (`/dashboard/billing/reconciliation`) holds the
money questions the billing job leaves for a person, each filed once, ever
(known by `detail.repair_key`):

| Item                                                                 | What to do                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renewal paid for a cycle the plan did not reach                      | Issue a refund (reason: Plan ended before this cycle), then close the item with what you did.                                                                                                               |
| Payment kept after the plan ended, before automatic refunds          | Look in the Razorpay dashboard for a refund already made by hand. If there is one, record it; if not, issue the refund. Close it.                                                                           |
| An automatic refund was refused                                      | The reason is on the item. Fix the cause, or refund another way and record it, then close it.                                                                                                               |
| A paid purchase was not applied (`purchase_refused:`)                | A closed-tab purchase the hourly check could not finish; nothing was applied or refunded. Apply it by hand as the note says, or refund in the Razorpay dashboard. Close it with what you did.               |
| A paid purchase was invoiced but not applied (`purchase_unapplied:`) | The invoice is issued and the merchant was told not to pay again. Apply the purchase by hand, or issue a refund. Close it.                                                                                  |
| Payment captured before its invoice was issued (`captured_draft:`)   | The repair pass issued and settled the invoice (no receipt went out). Check the plan, plan change or location was applied, then close it. If the store was deleted, refund the payment.                     |
| Invoice issued with the GST it was priced with (`kept_draft:`)       | A payment had fixed the total before the GST in force changed; the note gives both. If the merchant paid more than they owe, refund the difference with Issue a refund (its credit note follows). Close it. |

A superadmin opens Issue a refund or Record from the item where one applies (a
live store's renewal links to its store page; a purchase, captured-draft or
kept-draft item has **Open the store**); a member sees the item and why it
waits.
Closing an item still moves no money. When the failed-refund alert or the daily
"refunds waiting more than a day" alert arrives (`docs/monitoring.md`), act
within 2 working days: try again, or pay by bank transfer and record it, and
write to the merchant.

### ★ Complaints, blocks and holds (takedown)

Every complaint, court or government order and data request that reaches
StoreMink is logged here, with its legal deadlines, and every block of a
product, page, blog post, collection, review, blog comment, file or whole store
starts here. The order of work for each kind, the 2-hour path at night and the
by-hand steps are in [`takedown-runbook.md`](takedown-runbook.md); the design is
CODEBASE.md §5 convention 45. Every page calls `requireOperator()`, reads
through `lib/moderation/console-read.ts` and writes only through
`app/actions/takedown-actions.ts`, whose actions check the role again. Times are
India time, and every screen works at phone width (the on-call operator may be
on a phone at night).

**Who sees what.** Every operator (member or superadmin) sees complaints,
blocks, holds and the record; logs, acknowledges, resolves and reopens
complaints; blocks items (a store's own request included); replies to stores;
retries a file; marks a theme file removed by hand. Only a superadmin keeps a
block from the store, tells the store later, suspends a whole store, lifts any
block, opens or downloads an archived copy, keeps one longer or releases its
hold, and puts a store on hold or releases it. A member never sees those
buttons (Tell the store now, Lift block, Open the copy, Keep longer, Release
hold, whole-store suspension), and on the block form sees **Tell the store**
ticked and unavailable with "Only a superadmin can keep a block from the store,
and only for a court or government order that says so." under it.

**The list** (`/dashboard/complaints`): **Log a complaint** and **Block an
item**, and the tabs Open, Due soon, Overdue, Store replies, Blocks, Files,
Holds and Resolved, each with its count (`?view=`). `?store=<store id>` shows
one store's complaints, blocks and holds ("Only one store's complaints, blocks
and holds are shown.", with Show every store; the tab counts hide while
filtered, since they count every store). 50 rows a page (`?page=`); Holds reads
up to 200 active holds. Complaint rows carry no complainant details. A read
that fails says so; it is never shown as zeroes or an empty list.

**Log a complaint** (`/dashboard/complaints/new`): when it reached us (India
time; the deadlines count from it), how, what it is (each kind with its
deadlines), the complainant and how to reach them, who they act for, the order
or reference, the store (searched), up to 50 web addresses and a summary. The
line under the form shows the deadlines live. "Our complaint form" is never
offered as a channel (decision D11: the public form is next release).

**The complaint page** (`/dashboard/complaints/SM-000123`): the Deadlines card
(only the stages that kind has), the Details card (erased 3 years after it was
resolved), then **Send acknowledgement** (to an email contact) or **Mark as
acknowledged**, **Change kind** (a deadline only ever moves earlier), **Block an
item** (the block form with this complaint chosen), **No removal needed** (or
**Information provided**, **Request answered**), **Resolve** (a note for Not
removed and Partly removed; "Email the outcome" ticked when there is an email)
and **Reopen**; then its blocks and its history.

**Block an item** (`/dashboard/complaints/block`, `?complaint=SM-000123` from a
complaint, `?store=<id>&kind=store` from a store page): find it by address (a
store page, an image, an optimizer or share-image address, a `/themes/` file),
by store and search, or as a whole store (superadmin); confirm what was found
(where it appears, its reviews or comments to block one by one, its images to
tick, the warnings: homepage, theme image, built-in theme file, a file
StoreMink does not store, already blocked); then why (the reason, the legal
basis for an order, the complaint, the message to the store prefilled by
reason, **Tell the store**). A Theme Studio preview store is refused; a theme
demo store can be blocked but is never used for tests.

**A block's page** (`/dashboard/complaints/blocks/[blockId]`): its facts (store,
address, who blocked it and when, reason, legal basis, complaint, whether and
when the store was told, whether it opened the notice); a file's state with
**Retry now** or **Mark as removed** where they apply; for a whole store, the
store copy's progress ("Copying files: 412 of 1,200", then "Complete: 1,200
files, 3 missing"); **Tell the store now**; the archived copy (above: the
reason first, the 10-minute receipt, **Download record**, **Download** per
file, **Keep longer** to a date or until released with who asked, **Release
hold** with a note, its fingerprint after the purge); the conversation with the
store (**Send**, **Add the store's emailed reply**; a block kept from the store
has no one to reply to yet); **Lift block** (why, shown to the store; tell the
store by email; also lift its image blocks), refused while the file is being
replaced; and the history.

**The four Overview queues**, first in Needs attention: **Complaints due**
(next deadline within 6 hours or passed), **Store replies** (stores waiting for
an answer about a block), **Files to finish** (a blocked file still in storage,
or to be removed by hand) and **Holds to review** (a hold whose review date has
come). They come from `moderationQueueSql()` inside the one summary statement
of `lib/platform/overview.ts`, so the Overview now needs migration 0269.

**The store page** (`/dashboard/stores/[storeId]`): a **Complaints and holds**
card (blocked items, open complaints, "Suspended by a block since ..." when it
is, and the hold state, each a link into Complaints filtered to the store),
with **Suspend on a complaint** and **Put on hold** for a superadmin. While the
store is held, a banner above its heading names who held it, when and why, with
**Release hold** (a note is required). The plain **Suspend** asks why (above)
and records `store_suspended` with the note; **Activate** is off, with the
reason under it, while a whole-store block suspends the store ("This store is
suspended by a block on a complaint. Lift the block in Complaints."), and the
server refuses it anyway. **Delete store** is off, with the reason under it,
while the store is held ("This store is on hold for an investigation. Release
the hold first."), while one of its archives is still being copied ("StoreMink
is still keeping a copy of something blocked on this store. Try again in a few
minutes."), or when that check itself could not be read; `deleteStore` refuses
the same cases before it touches anything. The stores list shares the same
Suspend dialog.

## Phases

- **Phase 1 — IA, stores, themes, pricing ✅**
  New nav; `StoresConsole` moved to `/dashboard/stores`; store detail page
  (`lib/platform/store-detail.ts`); `ThemesPanel` → `/dashboard/themes` and
  `PricingPanel` → `/dashboard/pricing`, both superadmin-only; home rebuilt as a
  real overview (`lib/platform/overview.ts`) with a 12-week signup chart, plan
  mix, six attention queues and latest signups.
  The list's **History drawer was removed** rather than left alongside the
  detail page — two paths to the same data is the mess this revamp is undoing.
- **Phase 2 — People ✅**
  `/dashboard/people` (`lib/platform/people.ts`) unions `admins` and `pos_staff`
  across every store, searchable by name/email/store, filterable by access kind,
  and deep-linkable to one store (`?store=`) from the store detail page.
  - **★ `kind` IS NEVER COLLAPSED.** A dashboard login and a till PIN are
    different access with different reach; a flattened list would make revoking
    the wrong one look identical to revoking the right one.
  - **★ THE SAME PERSON MAY APPEAR TWICE, AND THAT IS CORRECT.** A shop owner
    who also rings the till has both rows — two credentials, revoked
    separately. Deduplicating by email would hide one.
  - **★ THE CHIP COUNTS IGNORE THE KIND FILTER.** Counted under the search and
    store filters alone, so selecting "Till" still reports how many dashboard
    admins the same search returns. Counting them under the full filter makes
    every unselected chip read zero, which is a dead end rather than a filter.
  - **★ `peopleHref` IS ONE TESTED BUILDER** (`lib/platform/people-links.ts`).
    A "next page" link that forgets `?q=` turns a filtered list into an
    unfiltered one that still looks filtered, and the only symptom is rows
    nobody asked for. Switching a chip resets paging for the mirror reason: a
    term matching four people has no page 4, and an empty screen reads as "no
    results".
- **Phase 3 — Logs hub ✅**
  Email logs, SMS logs and the cross-store failure feed behind one entry at
  `/dashboard/logs`, with 307s from the old `/dashboard/email-logs` and
  `/dashboard/failures`.
  - **★ `LogsRail` TAKES ITS REGISTRY AS A PROP.** Both consoles share
    `DashboardSidebar`, and their logs are NOT the same set — an operator has no
    import/export jobs and no per-store activity feed, a merchant has no
    cross-store failure view. Hardcoding `LOG_TYPES` would have put three rail
    entries in front of routes the platform does not have. It defaults to the
    merchant registry, so every existing call site is unchanged.
  - **★ A LANDING, NOT A REDIRECT TO THE FIRST LOG.** The merchant hub can
    default to its Activity feed; the platform has no cross-store equivalent, so
    "Logs" would silently mean "Email logs" and hide that the other two exist.
  - **★ `getSmsLogs` GAINED HOST-DERIVED SCOPE**, mirroring `getEmailLogs`. It
    used `getActingStoreId()`, whose never-null fallback resolves the WholeSip
    store — so on the operator console it would have served one merchant's SMS
    log as though it were the platform's. The platform scope re-checks operator
    membership inside the action, because a server action is an independently
    reachable POST endpoint.
  - **★ `log-types.test.ts` IS A DRIFT GUARD IN BOTH DIRECTIONS**: `fs.readdir`
    asserts every rail entry has a page, and every page has a rail entry. It
    also fails if the platform registry ever acquires the merchant-only keys —
    the guard against "tidying up" by pointing the platform sidebar at
    `LOG_TYPES`.
  - **⚠ The platform SMS log is EMPTY today**, and honestly so: nothing writes
    a `store_id IS NULL` row because there is no platform Twilio account. The
    page exists because adding it at the moment the first message goes out is
    how a send with no log ships.
- **Phase 4 — Announcements ✅**
  `/dashboard/announcements` — draft, check the reach, test-send, send, and a
  per-recipient log. Schema: `announcements_01_schema.sql` (applied by hand as
  `postgres` before the migration ledger; read it in git history).
  - **★ RECIPIENTS ARE MATERIALISED AT SEND, NOT RESOLVED AT DELIVERY.** The
    audience is a query over a moving target — stores sign up, staff leave,
    plans lapse. Writing a row per person makes the send idempotent (a retried
    worker claims rows rather than re-running a query that now returns
    different people), resumable across the 60s request ceiling, and
    **auditable**: "who was told, and when?" is answerable months later, which
    for a pricing or policy notice is the only thing that matters.
  - **★★ `category` DECIDES WHETHER CONSENT APPLIES, so it is a stored column
    and not a checkbox.** `feature` is marketing and honours
    `admins.marketing_opt_in`; `operational` is service correspondence about an
    account somebody already has and does not. Somebody has to be able to answer
    "why did this person get this after opting out?", and "it was a billing
    deadline" only holds if the category was recorded at the time.
  - **★ TILL STAFF ARE NEVER MARKETED TO.** `pos_staff` has no
    `marketing_opt_in` column — nobody ever asked them — and an absent
    preference is not consent. They still receive operational notices.
  - **★ EVERY SKIP CARRIES A REASON.** "38 skipped" tells an operator nothing
    about whether their audience is wrong or their list is dirty; "31 not opted
    in, 7 suppressed" does.
  - **★ THE PREVIEW RUNS THE SAME CODE AS THE SEND**, and the send button
    requires one — "send to everyone" should not be reachable without having
    looked at who everyone is. The confirm quotes the number back.
  - **★ THE TEST-SEND TAKES NO RECIPIENT.** It mails the session's own address.
    A recipient parameter would be an open relay: any operator could mail
    arbitrary HTML to any address from StoreMink's verified sending domain.
  - **★ EVERY MESSAGE LEAVES THROUGH `sendEmail`**, so it lands in `email_logs`
    under the `announcement` mailer and `send-coverage.test.ts` keeps it there.
    The worker rides `/api/cron/send-emails` rather than taking a new Cloud
    Scheduler entry — `docs/cron-jobs.md` records a documented-but-never-created
    job three times.
  - **★ A SENT ANNOUNCEMENT IS IMMUTABLE**, enforced as a predicate on the
    UPDATE rather than a read-then-write. Editing copy already in inboxes makes
    the log a record of what we currently _say_ we sent.
  - **★ `partial` IS A REAL OUTCOME.** Some bounced and the rest were told;
    calling that "failed" invites an operator to send the whole thing again.
  - **⚠ SMS is built and gated** — see below. Sending refuses with its reason
    and writes no recipient rows.
- **Phase 5 — Mink AI run and cost inspector ✅**
  `/dashboard/mink` adds a redacted, read-only view of the last 1, 7 or 30 days
  of agent runs. Summary cards expose success rate, p95 latency, retries,
  tokens, known provider cost, shadow credits/cohorts, feedback,
  unknown/partial cost and timeouts; the run table exposes only safe trace
  metadata and distinct tool names. Store detail pages also control invited
  beta membership. The pricing schedule is stored on each usage row so a future
  model price change does not rewrite historical estimates.
- **Phase 6, complaints and takedowns ✅** (Release 2, migrations 0269 and 0270)
  The Complaints entry, its five pages, the two archive routes, the four
  Overview queues, the store page's Complaints and holds card, hold banner and
  Suspend dialog: "Complaints, blocks and holds" above.

## ⚠ Announcement SMS cannot send yet, and that is not a code problem

Decided 2026-08-15. Building it gated rather than omitting it, so the audience,
composer and log are designed for two channels from the start.

### ⚠ "But signup already sends an SMS OTP"

It does, and it is not a counterexample. That message comes from
`PhoneAuthProvider.verifyPhoneNumber` (§19) — the **Firebase Web SDK, in the
browser**. Google sends it from its own infrastructure, on its own carrier
relationships and its own DLT registration; the "StoreMink" in the body is the
Firebase project's display name inside Google's fixed template.

Three consequences worth knowing:

- **No StoreMink code is in that path.** It never touches `lib/sms/`, so it
  leaves no row in `sms_logs` and appears in no operator log.
- **It cannot carry your own copy.** It is a fixed-purpose verification API:
  the only variable is a Google-generated code.
- **It is transactional auth**, a different regulatory category from a
  promotional announcement regardless of who sends it.

So StoreMink genuinely has no sender of its own for arbitrary SMS.

### The three blockers

Three things are missing, and only the first is ours:

1. **StoreMink has no Twilio account of its own.** SMS is BYO-per-store (§37) —
   `store_sms_providers` holds a merchant's credentials, and there is no
   platform-level equivalent. Sending _to_ merchants needs one.
2. **DLT registration.** Every commercial SMS to an Indian number needs a
   registered Principal Entity, a 6-character sender header, and an **approved
   template per message body**. A body that does not match is dropped at the
   carrier — silently, with no bounce. 7–21 business days.
3. **A feature announcement is PROMOTIONAL, not transactional.** That is a
   different and heavier compliance surface than the transactional templates
   §37 already models: numeric sender headers, DND/NDNC scrubbing, and time-of-day
   restrictions.

Until all three exist, the SMS channel must **refuse with a stated reason**
rather than queue messages every carrier will drop. This is `available: false`
in `lib/notifications/channels.ts` applied one level up, and §23's rule that a
control which always fails is worse than no control.

## Testing

There is no cross-browser or authenticated-console E2E infrastructure (CODEBASE
§2), and the console sits behind an email-OTP login. What is checked:

- **Typecheck, lint, build and the full vitest suite**, all green.
- **Column audit**: every table and column named in the raw SQL of
  `lib/platform/*.ts` verified against `drizzle/schema.ts`, which is introspected
  from the live database and is therefore authoritative on names.
- **⚠ The SQL has not been executed.** The local Cloud SQL Auth Proxy resets
  every connection when its ADC token has expired (§6), which is the state this
  was written in. **Run `gcloud auth application-default login`, restart
  `npm run db:proxy`, then load `/dashboard` and one store detail before
  merging** — a raw-SQL mistake that typecheck cannot see would surface exactly
  as the empty/`ok: false` state, which is also what a dead proxy looks like.
