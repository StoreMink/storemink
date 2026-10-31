# Storefront redesign production acceptance

The twelve-minute goal is a performance target. It is never a reason to fail,
discard, crop away or charge for unfinished work. Provider availability cannot
be guaranteed by application code. Production acceptance requires evidence that
temporary provider errors recover, and measurements under representative load.

## Implemented recovery

- Recovery policy 2 keeps unfinished full redesigns claimable past their time
  target and the legacy wall-clock ceiling. Invocation limits hand work over.
  A six-hour recovery ceiling still ends a job whose fault never clears.
- Known capacity refusals and transient database connection/transaction faults
  schedule retries without consuming the real failure counter.
- Checked photographs, paid photo candidates, private anchor candidates,
  correction notes and attempt reservations survive restarts. Known free image
  admission failures give their reservation back.
- Reviewer outages keep candidates parked for review. Storage-check outages
  delay finalization. Neither is permission to accept unchecked images.
- Preview design and Stop remain available while the retry is scheduled.
- The final checks run before the card; a check they leave open is noted on
  the card and never fails the job. Existing card ids keep retries from
  charging twice; a stored card can be settled after its runner disappears.
- Quality and spend still have limits. Invalid requests, permanent provider
  refusals, revoked access, configuration faults and programming errors need
  explicit outcomes; no zero-error claim is made.

## Database upgrade

Migration `20261028_0260_mink_redesign_recovery_fence` installs the fence.
Previously applied migrations 0258 and 0259 remain immutable; the 0259 guard
stays in place and fires for no row.

The fence is a BEFORE UPDATE trigger on unfinished recovery-policy jobs. A
transaction that has not declared the protocol may record Stop and nothing
else: its claim is refused and its other writes (an older sweep's expiry, a
checkpoint) are skipped. Compatible repository transactions declare the
protocol locally to that transaction. Legacy jobs and refinements are
untouched, so the upgrade needs no table lock and no preflight, and no
in-flight legacy job is converted.

The fence is applied to the local database and exercised by
`jobs.local.test.ts`. Staging applies it on the next `dev` build, production
on the next `main` build; complete each rollout before measuring.

## Required staging evidence

Use staging-only model and storage resources, explicitly approved spend and
synthetic stores. Do not run paid probes, enable a paid capacity tier, inspect
production or change production infrastructure without the corresponding
approval.

1. Run representative stores with the exact production 2K MEDIUM image
   request. Include one store, concurrent stores and competing Theme Studio
   traffic at busy and quiet hours. Measure click-to-ready p50/p90/p95, queue
   delay, planning repairs, provider refusals, review latency, retained photos,
   visual quality and actual provider usage/cost. The current cost/time tables
   are historical estimates, not results for this recovery policy.
2. Interrupt an invocation after paid images are stored. Verify a new worker
   completes the same job, reuses those images and creates only one card and
   one charge. Recheck a paid and a free full redesign.
3. Exercise capacity refusal, reviewer outage, storage-check failure and
   database reconnect. Clear each fault and verify automatic continuation
   without a new merchant start or loss of completed work.
4. Stop during a queued wait, paced admission, image draw and finalization.
   Verify no incomplete redesign is charged or applied, and the UI reports the
   outcome honestly. Apply, Publish and Undo remain human actions.
5. Validate the migration preflight and a rolling deployment with incompatible
   workers. Confirm old sweep logic cannot expire the preserved job and the
   normal production heartbeat resumes a stalled job after the browser closes.
6. Verify Priority separately before considering it: exact supported model,
   endpoint and request headers, returned traffic type, refusal rate, latency
   and billed tier. A historical downgrade alone does not establish its cause.

The shared Standard image pacer now holds a 40-second recovery minimum for
ten minutes after the latest refusal cooldown, within its 31-to-45-second
bounds (31 s is Google's non-adjustable system limit of two image
generation requests a minute per project per base model, read in the Quotas
console on 28 Oct 2026). Existing database fields preserve the hold across worker restarts;
no capacity migration is needed. Older workers can still narrow the gap
during deployment overlap, so complete their rollout before measurement.
The corrected staging probe defaults to 54 calls using the real 2K MEDIUM
photo request with an anchor and separate Standard/Priority ladders. Its dry
run reads no credentials and calls no service. One approved 27 Oct staging
pass sent 36 of 54 planned calls before an operator stop after finding an
HTTP 499 reservation bug. All nine successful Priority calls were downgraded;
eleven requests returned 429. Corrected usage plus conservative reserves totals
$6.73 against $8. Scheduling confounds prevent a rate comparison. Benchmark
accounting and scheduling now have regression fixes; no paid rerun occurred.
See `mink-capacity-test-2026-10-27.md` for evidence and the unsent escalation
draft. Google capacity remains unresolved. No production Priority tier or
reserved throughput has been enabled.
See `mink-revamp-speed.md` for the protocol and budget safeguards.
No merchant-visible change, no Help Centre update for this capacity-only work.
Production readiness remains pending
the database upgrade, staging evidence and an approved rollout.
