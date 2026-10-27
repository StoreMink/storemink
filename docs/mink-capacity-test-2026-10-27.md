# Staging capacity test, 27 Oct 2026

Google capacity remains unresolved. Nine successful requests explicitly asking
for Priority were all returned as `ON_DEMAND`; none returned
`ON_DEMAND_PRIORITY`. This is evidence of downgrade in this sample, not proof
of an account-configuration cause. Do not enable production Priority from this
run or promise twelve-minute redesigns.

## Scope and outcome

The owner approved one staging pass of 54 calls with an $8 guard. It ran on
`storemink-staging`, 07:15:38 to 07:42:55 UTC (12:45:38 to 13:12:55 IST),
27.3 minutes. Thirty-six requests were sent, eighteen skipped after an
operator stop. Already-started requests drained. There was no replacement
pass, production read, deployment, capacity purchase or support submission.

Draws: `gemini-nano-banana-2.1`, global, 2K MEDIUM, no people, JPEG quality
95, production prompt builder and one fixed JPEG `ANCHOR:` reference.
Priority requests configured both documented headers: request type `shared`
and shared request type `priority`. Review controls: `gemini-3.8-flash`, US,
a small synthetic candidate/anchor. They do not measure real-photo quality.
Each model request was attempted once. The quota project was pinned to
staging, overriding the ADC's unrelated default quota project.

| Work                        | Sent | Successful | 429 | Other errors |
| --------------------------- | ---: | ---------: | --: | ------------ |
| Standard image ladder       |   12 |          7 |   4 | one 504      |
| Priority image ladder       |   12 |          7 |   5 | none         |
| Standard paired images      |    3 |          2 |   1 | none         |
| Priority paired images      |    3 |          2 |   0 | one 499      |
| US Standard review controls |    6 |          5 |   1 | none         |
| Total                       |   36 |         23 |  11 | two          |

All eighteen returned photos had a final 1856 by 2304 image, with one thought
draft also reported. This is not an assessment of photographic quality.
None of the eleven 429 responses named a quota. One 504 reported
`DEADLINE_EXCEEDED`, and one 499 reported `CANCELLED`, both without usage.
The Standard ladder's successful-photo p50 was 38.3 s and p95 170.7 s.
A successful US review took 128.7 s. Tail latency and failures remain material.

## Limits of the comparison

The Standard ladder's measured gaps followed the plan: three successes each
at 60 and 40 seconds; at 30 seconds, one success, one 429 and one 504; at
15 seconds, three 429s. Three samples per rung do not establish a safe rate.

After the 504, its conservative budget reservation permitted only one
Priority draw in flight. Long responses delayed subsequent starts. A scheduler
bug then caught up to absolute planned times, compressing the final Priority
rung to about half a second instead of fifteen seconds. The initial paired
Standard draw also started only 3.4 seconds after that ladder. Those bursts
confound refusal comparisons. The run cannot establish a Priority rate or a
causal Standard-versus-Priority latency/refusal advantage. The returned traffic
types still directly show all nine successful Priority calls were downgraded.

This was a single midday pass, interrupted before the paired stage completed.
It bypassed our database pacer and did not run complete or concurrent store
redesigns. It does not validate a twelve-minute completion target.

## Spending and why the run stopped

Reported response usage prices to $1.156175625 at the script's list rates.
That is an estimate from token usage, not a reconciled Cloud Billing total.
The 504 has no usage and retains a $1.99008 conservative reservation.

The original script incorrectly treated HTTP 499 as a free admission error.
New calls were stopped when this was found. The cancelled Priority call also
needs a $3.582144 conservative reservation. Corrected unknown-usage reserves
total $5.572224; adding reported usage gives **$6.728399625 accounted**, below
the $8 authorization. These reserves are not actual charges. Final charges
for those two calls remain unknown; the original JSON/Markdown understates
the reserve and must be read with `corrected-accounting.json`.

## Benchmark corrections

- Only known admission/validation failures (400, 401, 403, 404, 429) release
  reservations. HTTP 499 and other unknown-cost errors retain the call ceiling.
- Each ladder start leaves its own rung's gap after the previous actual start,
  including after budget or slot waits. It cannot catch up with a burst.
- The paired stage leaves at least sixty seconds from preceding starts in its
  pools, just as the separate ladders do.
- Regression tests cover HTTP 499, delayed ladder starts and stage separation.

These corrections were made after the stopped process had loaded its source;
they did not change the live pass. No paid rerun was made. Production pacing
was not changed by these benchmark corrections.

## Evidence

Local evidence directory: `/private/tmp/mink-capacity-approved-20261027/`.
It contains the raw JSON/Markdown and returned photos, `probe-source-as-run.ts`,
`probe-tests-as-run.ts`, and a separate `corrected-accounting.json`.
Raw result: `priority-test-approved-capacity-20261027T071538Z.json`.
SHA-256: `7d7eb875bbd26a02e3b4fab7fa39c01c09bbd07eeb257283b2d8450dc238bc1f`.
Source-as-run SHA-256:
`fbffe22cc444cf32515c6dd7b88365ea600cd0b2b515d16647228379c8606b3c`.
The raw evidence is preserved unchanged and is not published or committed.

## Google escalation draft, not sent

Subject: Nano Banana 2.1 Priority requests downgraded in storemink-staging

Please investigate the staging window and model above. All nine successful
requests configured for Priority returned `ON_DEMAND`. Could you confirm this
organization's model-specific Priority eligibility, throughput accounting and
the downgrade reason? We have not measured other projects' organization-wide
traffic, so we cannot rule out its effect. Correlate these example responses:

| UTC start    | Response ID             | Requested | Returned  |
| ------------ | ----------------------- | --------- | --------- |
| 07:23:47.234 | g1HgaofKMsug7PkPhLO72AQ | Priority  | ON_DEMAND |
| 07:25:44.917 | -VHgavbcFKCDoLAP5vOvoQ0 | Priority  | ON_DEMAND |
| 07:28:44.014 | rFLgar3MGLuS7PkP99TesAk | Priority  | ON_DEMAND |

Please also investigate the unnamed 429s for global image generation and US
reviewing, and the 504/499 near the request timeout. Full timestamps, model
versions, available response IDs and error bodies are in the local evidence.
The Priority ladder had scheduling confounds described above; do not interpret
its nominal fifteen-second rung as a fifteen-second load test.

What workload, billing or organization setting could explain these downgrades?
If shared service cannot support our latency objective, please propose supported
Provisioned Throughput sizing and terms for this exact image model and reviewer.
Our redesign uses eight public photos plus a private style anchor, with quality
redraws; the desired completion time is twelve minutes. Concurrent-store demand
still needs sizing. This requests a diagnosis/proposal, not a capacity order.

Google documents `ON_DEMAND` as downgrade and directs workloads needing assured
capacity toward Provisioned Throughput:
[Priority PayGo documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo).
An unnamed 429 alone does not identify a quota to increase:
[429 guidance](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deploy/error-code-429).

No merchant-visible change, no Help Centre update. The recovery migration,
representative staging evidence and approved rollout remain outstanding.
