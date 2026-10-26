import { describe, expect, test } from "vitest";
import {
  GRANDFATHERED,
  GRANDFATHERED_VERIFY,
  GRANDFATHERED_LONG_DASH,
  GRANDFATHERED_INDEX_TIMESTAMP,
  GRANDFATHERED_WITNESS,
  HELP_LINT_RULES,
  INDEX_TIMESTAMP_RULE,
  DASH_LOOKALIKE_CLEANUP_ID,
  LONG_DASH_CLEANUP_ID,
  POS_WORDING_ID,
  POS_WORDING_RULE,
  extractReplacements,
  lintHelpSql,
  lintIndexTimestamps,
  lintLongDashes,
  lintManifest,
  lintPosWording,
  lintStaleQuotes,
  lintUnwitnessedEdits,
  lintVerifyContract,
  parseAllowMarkers,
  publishedText,
  touchesHelpContent,
} from "./help-content-lint.mjs";

const HELP = (content) =>
  `UPDATE public.help_articles SET body = $guide$${content}$guide$ WHERE slug = 'x';`;

const rules = (findings) => findings.map((f) => f.rule).sort();

describe("help content lint", () => {
  test("only inspects migrations that write Help content", () => {
    expect(touchesHelpContent("alter table orders add column x int;")).toBe(
      false,
    );
    expect(touchesHelpContent(HELP("<p>hi</p>"))).toBe(true);
    // A migration full of banned words that never touches Help is not our business.
    expect(
      lintHelpSql(
        "-- Phase 6A worker lease\nalter table mink_workflow_runs add column x int;",
      ),
    ).toEqual([]);
  });

  test("catches every category of content a merchant cannot act on", () => {
    const cases = {
      "operator-only": "Platform superadmins use the store management page.",
      "env-flag": "Check the global MINK_AI_ENABLED runtime switch.",
      infrastructure: "Run gcloud auth application-default login and restart.",
      internals: "The card survives Cloud Run restarts using idempotency keys.",
      "phase-label": "Phase 5C is deliberately narrow.",
      "changelog-voice":
        "Older instructions below are superseded by this control.",
    };
    for (const [rule, sentence] of Object.entries(cases)) {
      const found = rules(lintHelpSql(HELP(`<p>${sentence}</p>`)));
      expect(found, `${rule} should be caught in: ${sentence}`).toContain(rule);
    }
  });

  test("the exact paragraph that prompted this linter is rejected", () => {
    // Verbatim from 20260909_0091, which published it to merchants.
    const shipped =
      "<p>Platform superadmins now use one <strong>Enable Mink AI</strong> or " +
      "<strong>Disable Mink AI</strong> button on the store management page.</p>" +
      "<p>The global MINK_AI_ENABLED runtime switch remains an emergency shutdown. " +
      "MINK_BETA_REQUIRE_INVITE no longer bypasses store enablement.</p>";
    expect(rules(lintHelpSql(HELP(shipped)))).toEqual(
      expect.arrayContaining(["env-flag", "operator-only"]),
    );
  });

  test("ordinary merchant guidance is not flagged", () => {
    // A linter that flags normal work is a linter somebody disables. These are
    // real sentences from published guides, including the domain vocabulary
    // (GST, COD, SMS, DLT, AWB, NDR/RTO) that must never look like an env var.
    const ok = [
      "<p>Choose <strong>Refund</strong>, enter the amount, and confirm.</p>",
      "<p>GST is charged at the rate of the product's tax class. COD orders are collected by the courier.</p>",
      "<p>Send an SMS only after your DLT templates are approved. Check the AWB, and handle NDR or RTO in Shiprocket.</p>",
      "<p>Only the store owner can give a discount in POS. Ask your manager for a PIN.</p>",
      "<p>Your plan includes 2 locations. Extra locations are billed monthly.</p>",
      "<p>Pressing Refund twice cannot send the money twice.</p>",
      "<p>StoreMink support must separately enable this for your store.</p>",
      "<p>Set your store timezone in Settings so reports use local dates.</p>",
    ];
    for (const sentence of ok) {
      expect(lintHelpSql(HELP(sentence)), sentence).toEqual([]);
    }
  });

  test("text being DELETED is skipped, so a cleanup migration passes", () => {
    const cleanup =
      "UPDATE public.help_articles SET body = replace(body,\n" +
      "  $old$<p>Platform superadmins use MINK_AI_ENABLED.</p>$old$,\n" +
      "  $new$<p>Ask StoreMink support to switch this on for your store.</p>$new$);";
    expect(lintHelpSql(cleanup)).toEqual([]);
    // ...but the replacement text is still linted.
    const bad = cleanup.replace(
      "$new$<p>Ask StoreMink support to switch this on for your store.</p>$new$",
      "$new$<p>Set MINK_AI_ENABLED on Cloud Run.</p>$new$",
    );
    expect(rules(lintHelpSql(bad))).toEqual(
      expect.arrayContaining(["env-flag", "infrastructure"]),
    );
  });

  test("SQL comments are free, so internals can be explained to the next reader", () => {
    const sql =
      "-- Phase 6A: the worker lease and idempotency keys live in Cloud Run.\n" +
      HELP("<p>Your report keeps running if you close the tab.</p>");
    expect(lintHelpSql(sql)).toEqual([]);
    expect(publishedText(sql)).not.toContain("Phase 6A");
  });

  test("short literals like slugs and statuses are not prose", () => {
    // 'published' and a slug must not be searched for prose defects.
    expect(
      publishedText(
        "update help_articles set status='published' where slug='a-b-c';",
      ),
    ).toBe("");
  });

  test("an allow marker suppresses one rule and requires a reason", () => {
    const marked =
      "-- help-lint: allow phase-label — the merchant-facing rollout is named Phase 2 in the contract\n" +
      HELP("<p>Phase 2 pricing applies.</p>");
    expect(lintHelpSql(marked)).toEqual([]);
    expect(parseAllowMarkers(marked).get("phase-label")).toMatch(/contract/);
    // A marker with no reason is not a marker.
    expect(parseAllowMarkers("-- help-lint: allow phase-label\n").size).toBe(0);
    // It suppresses only the rule it names.
    const partial =
      "-- help-lint: allow phase-label — reason\n" +
      HELP("<p>Phase 2 uses MINK_AI_ENABLED.</p>");
    expect(rules(lintHelpSql(partial))).toEqual(["env-flag"]);
  });

  describe("durable verify may not assert published wording", () => {
    const copyQuery = {
      name: "guide published",
      sql: "select count(*)::text from public.help_articles where slug='g' and body like '%<h2>Do a thing</h2>%'",
      equals: "1",
    };

    test("rejects a copy assertion in the durable block", () => {
      const findings = lintVerifyContract({
        id: "20260911_0094_example",
        verify: { queries: [copyQuery] },
      });
      expect(rules(findings)).toEqual(["durable-verify-copy"]);
      expect(findings[0].message).toMatch(/applyVerify/);
    });

    test("accepts the same assertion in applyVerify, and structure in verify", () => {
      expect(
        lintVerifyContract({
          id: "20260911_0094_example",
          verify: { tables: ["help_articles"] },
          applyVerify: { queries: [copyQuery] },
        }),
      ).toEqual([]);
    });

    test("the seven migrations that froze copy before the rule are recorded", () => {
      expect(GRANDFATHERED_VERIFY.size).toBe(7);
      // 0077 is why "Phase 7B ..." is still in a merchant guide.
      expect(GRANDFATHERED_VERIFY).toContain(
        "20260904_0077_mink_phase_7b_storefront_code_preview",
      );
      expect(
        lintVerifyContract({
          id: "20260904_0077_mink_phase_7b_storefront_code_preview",
          verify: { queries: [copyQuery] },
        }),
      ).toEqual([]);
    });
  });

  test("every rule has a name and an actionable message", () => {
    for (const rule of HELP_LINT_RULES) {
      expect(rule.name).toMatch(/^[a-z][a-z-]*$/);
      expect(rule.message.length).toBeGreaterThan(40);
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
  });

  test("the enrolled manifest passes, and grandfathering is not open-ended", () => {
    // Every grandfathered key names a migration and a rule that exists, so a
    // renamed rule cannot silently keep excusing history.
    const names = new Set(HELP_LINT_RULES.map((r) => r.name));
    for (const key of GRANDFATHERED.keys()) {
      const rule = key.slice(key.lastIndexOf(":") + 1);
      expect(names, key).toContain(rule);
    }
  });

  test("the whole manifest is clean today", async () => {
    const { failures, checked } = await lintManifest();
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(80);
  });

  describe("stale replace() quotes", () => {
    const pub = (text) =>
      `UPDATE public.help_articles SET body = $guide$${text}$guide$ WHERE slug='g';`;
    const edit = (search, replacement) =>
      `UPDATE public.help_articles SET body = replace(body, $old$${search}$old$, $new$${replacement}$new$) WHERE slug='g';`;
    const mig = (id, sql) => ({ id, file: `sql/${id}.sql`, sql });

    const PARA =
      "Mink reads the attachment and prepares a proposal. The message is limited to 4,000 characters.";

    test("★★ flags a quote an earlier migration already invalidated", () => {
      // Exactly the production failure: 0120 publishes a paragraph, 0121
      // rewrites its closing sentence, 0124 still quotes the 0120 wording.
      const failures = lintStaleQuotes([
        mig("0120", pub(PARA)),
        mig(
          "0121",
          edit(
            "The message is limited to 4,000 characters.",
            "The message is limited to 12,000 characters.",
          ),
        ),
        mig("0124", edit(PARA, "Something else entirely.")),
      ]);
      expect(failures.map((f) => f.id)).toEqual(["0124"]);
      expect(failures[0].rule).toBe("stale-quote");
    });

    test("the same edit quoted at sentence level is fine", () => {
      // The fix: quote only the sentence you are changing, so a sibling
      // migration editing a different sentence cannot expire your quote.
      expect(
        lintStaleQuotes([
          mig("0120", pub(PARA)),
          mig(
            "0121",
            edit(
              "The message is limited to 4,000 characters.",
              "The message is limited to 12,000 characters.",
            ),
          ),
          mig(
            "0124",
            edit(
              "Mink reads the attachment and prepares a proposal.",
              "Mink reads the attachment, prepares a square copy and proposes.",
            ),
          ),
        ]),
      ).toEqual([]);
    });

    test("a chain of edits to the same sentence stays valid", () => {
      // Each migration quotes what its predecessor left behind.
      expect(
        lintStaleQuotes([
          mig("a", pub("Refunds take five days to arrive.")),
          mig(
            "b",
            edit(
              "Refunds take five days to arrive.",
              "Refunds take three days to arrive.",
            ),
          ),
          mig(
            "c",
            edit(
              "Refunds take three days to arrive.",
              "Refunds usually arrive the next working day.",
            ),
          ),
        ]),
      ).toEqual([]);
    });

    test("★★ keeps identical wording isolated by article slug", () => {
      const shared =
        "This sufficiently long sentence is intentionally shared by both guides.";
      expect(
        lintStaleQuotes([
          mig("a-publish", pub(shared).replace("slug='g'", "slug='guide-a'")),
          mig("b-publish", pub(shared).replace("slug='g'", "slug='guide-b'")),
          mig(
            "a-edit",
            edit(
              shared,
              "Only guide A receives this sufficiently long edit.",
            ).replace("slug='g'", "slug='guide-a'"),
          ),
          mig(
            "b-edit",
            edit(
              shared,
              "Only guide B receives this sufficiently long edit.",
            ).replace("slug='g'", "slug='guide-b'"),
          ),
        ]),
      ).toEqual([]);
    });

    test("associates VALUES-published bodies with their own article slug", () => {
      const shared =
        "This sufficiently long sentence is intentionally shared by inserted guides.";
      const inserted = mig(
        "publish",
        `INSERT INTO public.help_articles (slug, title, excerpt, body) VALUES
          ('guide-a', 'Guide A', 'Guide A excerpt', $article$${shared}$article$),
          ('guide-b', 'Guide B', 'Guide B excerpt', $article$${shared}$article$);`,
      );
      expect(
        lintStaleQuotes([
          inserted,
          mig(
            "a-edit",
            edit(
              shared,
              "Only inserted guide A receives this long edit.",
            ).replace("slug='g'", "slug='guide-a'"),
          ),
          mig(
            "b-edit",
            edit(
              shared,
              "Only inserted guide B receives this long edit.",
            ).replace("slug='g'", "slug='guide-b'"),
          ),
        ]),
      ).toEqual([]);
    });

    test("★★ does not borrow a current quote from another article", () => {
      const shared =
        "This sufficiently long sentence is intentionally shared by both guides.";
      const failures = lintStaleQuotes([
        mig("a-publish", pub(shared).replace("slug='g'", "slug='guide-a'")),
        mig(
          "a-edit",
          edit(
            shared,
            "Guide A already changed this sufficiently long sentence.",
          ).replace("slug='g'", "slug='guide-a'"),
        ),
        mig("b-publish", pub(shared).replace("slug='g'", "slug='guide-b'")),
        mig(
          "a-stale",
          edit(
            shared,
            "This stale Guide A edit must be rejected by the replay.",
          ).replace("slug='g'", "slug='guide-a'"),
        ),
      ]);
      expect(failures.map((failure) => failure.id)).toEqual(["a-stale"]);
    });

    test("⚠ text this has never seen published is skipped, never flagged", () => {
      // It names copy from the article's original insert, which predates the
      // fragments a replay can reconstruct. Flagging it would be noise, and a
      // noisy linter is one somebody switches off.
      expect(
        lintStaleQuotes([
          mig("a", edit("wording from the baseline article", "new wording")),
        ]),
      ).toEqual([]);
    });

    test("extracts the search and replacement of each pair", () => {
      expect(extractReplacements(edit("before", "after"))).toEqual([
        { search: "before", replacement: "after" },
      ]);
      // A comment quoting the old text must not be read as a replacement.
      expect(extractReplacements(`-- was $old$x$old$, $new$y$new$\n`)).toEqual(
        [],
      );
    });

    test("every shipped migration survives the replay", async () => {
      // The guard is only affordable because the real ledger passes it: a
      // linter that flags existing, correct migrations is one nobody runs.
      const { failures } = await lintManifest();
      expect(failures.filter((f) => f.rule === "stale-quote")).toEqual([]);
    });
  });

  describe("edits nothing could prove happened", () => {
    const edit = (search, replacement) =>
      `UPDATE public.help_articles SET body = replace(body, $old$${search}$old$, $new$${replacement}$new$) WHERE slug='g';`;
    const mig = (sql, queries) => ({
      id: "x",
      file: "sql/x.sql",
      sql,
      applyVerify: queries ? { queries } : undefined,
    });
    const q = (pattern, equals = "1") => ({
      name: "check",
      sql: `select count(*)::text from help_articles where body like '%${pattern}%'`,
      equals,
    });

    test("★★ flags a replace() with no postcondition at all", () => {
      const found = lintUnwitnessedEdits(mig(edit("old text", "new text")));
      expect(found.map((f) => f.rule)).toEqual(["unwitnessed-edit"]);
    });

    test("a query naming wording unique to the replacement witnesses it", () => {
      expect(
        lintUnwitnessedEdits(
          mig(edit("refunds take five days", "refunds arrive next day"), [
            q("refunds arrive next day"),
          ]),
        ),
      ).toEqual([]);
    });

    test("★★ a check satisfied by the UNEDITED body proves nothing", () => {
      // The trap this rule exists for: the pattern is in both halves, so the
      // assertion passes whether or not replace() matched anything.
      expect(
        lintUnwitnessedEdits(
          mig(edit("refunds take five days", "refunds take three days"), [
            q("refunds take"),
          ]),
        ),
      ).toHaveLength(1);
    });

    test("an equals-0 check on the removed wording witnesses it too", () => {
      // Asserting the old text is GONE changes value when the edit lands.
      expect(
        lintUnwitnessedEdits(
          mig(edit("the alpha is read only", "Mink can edit a product"), [
            q("the alpha is read only", "0"),
          ]),
        ),
      ).toEqual([]);
    });

    test("every pair needs its own witness, not just one of them", () => {
      const two = [
        edit("first old", "first new"),
        edit("second old", "second new"),
      ].join("\n");
      expect(lintUnwitnessedEdits(mig(two, [q("first new")]))).toHaveLength(1);
      expect(
        lintUnwitnessedEdits(mig(two, [q("first new"), q("second new")])),
      ).toEqual([]);
    });

    test("migrations that publish without replacing are not asked for one", () => {
      // An INSERT cannot silently no-op the way replace() can.
      expect(
        lintUnwitnessedEdits(
          mig(
            "INSERT INTO help_articles (body) VALUES ($guide$<p>New guide.</p>$guide$);",
          ),
        ),
      ).toEqual([]);
    });

    test("⚠ the grandfathered set is applied SQL that cannot be changed", () => {
      // Editing an applied migration rewrites a recorded checksum and the
      // runner then refuses every later migration.
      expect(GRANDFATHERED_WITNESS.size).toBe(13);
      expect(
        lintUnwitnessedEdits({
          ...mig(edit("a", "b")),
          id: "20260920_0120_mink_automatic_attachments",
        }),
      ).toEqual([]);
    });

    test("every shipped migration is witnessed or grandfathered", async () => {
      const { failures } = await lintManifest();
      expect(failures.filter((f) => f.rule === "unwitnessed-edit")).toEqual([]);
    });
  });
  // ★ No em dash in Help copy once the cleanup has run (owner's rule).
  describe("long dashes", () => {
    const mig = (sql, id = "20261012_0185_next_help") => ({
      id,
      file: `sql/${id}.sql`,
      sql,
    });

    test("flags an em dash a Help migration publishes", () => {
      expect(
        rules(lintLongDashes(mig(HELP("<p>Save it \u2014 then publish.</p>")))),
      ).toEqual(["long-dash"]);
    });

    test("★ flags a quoted em dash too: that text no longer exists anywhere", () => {
      const quote = `UPDATE public.help_articles SET body = replace(body, $old$Save it \u2014 then publish.$old$, $new$Save it, then publish.$new$) WHERE slug = 'x';`;
      expect(rules(lintLongDashes(mig(quote)))).toEqual(["long-dash"]);
    });

    test("passes copy without one, and a dash that only sits in a comment", () => {
      expect(
        lintLongDashes(mig(HELP("<p>Save it, then publish.</p>"))),
      ).toEqual([]);
      expect(
        lintLongDashes(
          mig(
            `-- Why: the old guide said \u2014 this.\n${HELP("<p>Fine.</p>")}`,
          ),
        ),
      ).toEqual([]);
    });

    test("leaves migrations that never touch Help alone", () => {
      expect(
        lintLongDashes(mig("comment on table orders is 'a \u2014 b';")),
      ).toEqual([]);
    });

    // An en dash, or either dash as an HTML entity, renders the same dash.
    test.each([
      "<p>Realtime data can take 10\u201330 minutes.</p>",
      "<p><strong>Card</strong> &mdash; renewals are debited.</p>",
      "<p>Card &#8212; renewals.</p>",
      "<p>Mon &ndash; Fri</p>",
      "<p>Card &#x2014; renewals.</p>",
    ])("flags a dash in another spelling: %s", (content) => {
      expect(rules(lintLongDashes(mig(HELP(content))))).toEqual(["long-dash"]);
    });

    test("quoting an entity or an en dash to remove it passes: some are still live", () => {
      const cleanup = `UPDATE public.help_articles SET body = replace(body, $old$<strong>Card</strong> &mdash; renewals$old$, $new$<strong>Card</strong>: renewals$new$), updated_at = now() WHERE slug = 'x';`;
      expect(lintLongDashes(mig(cleanup))).toEqual([]);
    });

    test("migrations before the lookalike cleanup are held to the em dash only", () => {
      const entity = mig(HELP("<p>Card &mdash; renewals.</p>"));
      expect(lintLongDashes(entity, { lookalikes: false })).toEqual([]);
      expect(
        rules(
          lintLongDashes(mig(HELP("<p>Save it \u2014 then publish.</p>")), {
            lookalikes: false,
          }),
        ),
      ).toEqual(["long-dash"]);
    });

    test("the cleanup is in the manifest, so the rule actually switches on", async () => {
      const { failures } = await lintManifest();
      expect(failures.filter((f) => f.rule === "long-dash")).toEqual([]);
      const manifest = await import("../drizzle/migrations/manifest.json", {
        with: { type: "json" },
      });
      const ids = manifest.default.migrations.map((m) => m.id);
      expect(ids).toContain(LONG_DASH_CLEANUP_ID);
      // Only 0176, applied on staging before the cleanup existed; 0186 takes
      // its dash back out on production, where it lands after 0184.
      expect([...GRANDFATHERED_LONG_DASH]).toEqual([
        "20261008_0176_whatsapp_notify_help",
      ]);
      expect(
        ids.indexOf("20261012_0186_help_no_long_dashes_after_whatsapp"),
      ).toBeGreaterThan(ids.indexOf("20261008_0176_whatsapp_notify_help"));
      // The en dash and entity spellings switch on after 0254 removed the
      // last of them, so 0254 itself may quote them in $old$.
      expect(ids.indexOf(DASH_LOOKALIKE_CLEANUP_ID)).toBeGreaterThan(
        ids.indexOf(LONG_DASH_CLEANUP_ID),
      );
    });
  });

  // ★ POS, never "register" or "till", once 0253 has rewritten the guides
  // (owner's rule, 26 Oct 2026).
  describe("pos wording", () => {
    const mig = (sql, id = "20261027_0300_next_help") => ({
      id,
      file: `sql/${id}.sql`,
      sql,
    });
    const flagged = (sentence) => rules(lintPosWording(mig(HELP(sentence))));

    test.each([
      "<p>Take the return at the register.</p>",
      "<p>Invite register staff from Settings.</p>",
      "<p>Pro includes 2 locations, 5 tills per location.</p>",
      "<p>Every paired till must be authorised again.</p>",
      "<p>Lock the cash register before you leave.</p>",
      "<p>Open Point of Sale in the dashboard.</p>",
      "<p>Use the quick counter login.</p>",
      "<p>Website + counter, always in sync.</p>",
      // Banned by default: the 6 of 0253's 136 removed sentences that a list
      // of phrase shapes missed, and the old word on its own.
      "<p>Learn how to authorise a StoreMink till.</p>",
      "<p>It is valid only for that store, location, till, operator and cart.</p>",
      "<p>The cashier explains the issue; there is no till override.</p>",
      "<p>A sale rung at this same register stays open.</p>",
      "<h2>POS opens the product page instead of my register</h2>",
      "<p>Later claiming a till-created profile does not create a second balance.</p>",
      "<h2>Register</h2>",
      "<p>Select Open register to start.</p>",
    ])("flags %s", (sentence) => {
      expect(flagged(sentence)).toEqual(["pos-wording"]);
    });

    // The other meanings the owner kept: signing up, GST and DLT
    // registration, a WhatsApp template or number, the registered office,
    // "till" as until, the counter.
    test.each([
      "<p>Coupon emails go to registered customers.</p>",
      "<p>Finish your DLT registration first, then register its sender header.</p>",
      "<p>Ask an adviser to confirm the business's GST registration.</p>",
      "<p>Our registered office is in Faridkot.</p>",
      "<p>The email carries a registration link. Choose Complete registration.</p>",
      "<p>The offer is valid till 31 March.</p>",
      "<p>Pay at the counter. Counter returns are taken at the counter device.</p>",
      "<p>StoreMink POS (point of sale) is how you sell in person.</p>",
      '<p><a href="/help/point-of-sale/process-an-in-store-sale">Sell</a> in POS.</p>',
      '<p>See <a href="/help/point-of-sale/configure-pos-register-settings">POS settings</a>.</p>',
      "<p>Register the SMS wording on the DLT portal before you paste its template ID.</p>",
      "<p>StoreMink mirrors that approved record; it does not register or change the portal template.</p>",
      "<p>StoreMink registers one for each order update when you connect WhatsApp.</p>",
      "<p>If Meta refused to register the number, try again.</p>",
    ])("leaves %s alone", (sentence) => {
      expect(flagged(sentence)).toEqual([]);
    });

    // A title is shorter than the 30 characters publishedText reads in
    // single quotes, so the value given to a reader's field is read anyway.
    test.each([
      "UPDATE public.help_categories SET title = 'Point of Sale', updated_at = now() WHERE slug = 'point-of-sale';",
      "UPDATE public.help_categories SET title = replace(title, $old$POS$old$, 'Point of Sale'), updated_at = now() WHERE slug = 'point-of-sale';",
      "UPDATE public.help_articles SET seo_title = 'Open the till', updated_at = now() WHERE slug = 'x';",
      "UPDATE public.help_categories SET description = 'Choose where the till goes' WHERE slug = 'x';",
      "INSERT INTO public.help_categories (slug, title, description) VALUES ('pos', 'Point of Sale', 'Sell in person.');",
    ])("flags a short value a statement publishes: %s", (sql) => {
      expect(rules(lintPosWording(mig(sql)))).toEqual(["pos-wording"]);
    });

    test.each([
      "UPDATE public.help_categories SET title = 'POS', updated_at = now() WHERE slug = 'point-of-sale' AND title = 'Point of Sale';",
      "UPDATE public.help_categories SET title = replace(title, 'Point of Sale', 'POS') WHERE slug = 'point-of-sale';",
      "INSERT INTO public.help_categories (slug, title, description) VALUES ('point-of-sale', 'POS', 'Sell in person.');",
    ])("leaves the old title alone where it is only looked up: %s", (sql) => {
      expect(lintPosWording(mig(sql))).toEqual([]);
    });

    test("text being removed is not published, so a cleanup passes", () => {
      const cleanup = `UPDATE public.help_articles SET body = replace(body, $old$at the register$old$, $new$in POS$new$), updated_at = now() WHERE slug = 'x';`;
      expect(lintPosWording(mig(cleanup))).toEqual([]);
    });

    test("an allow marker needs a reason, like every other rule", () => {
      const allowed = `-- help-lint: allow pos-wording -- quotes a customer's own words\n${HELP("<p>They said: the till froze.</p>")}`;
      expect(lintPosWording(mig(allowed))).toEqual([]);
    });

    test("★ applies only AFTER 0253: applied guides that said register are not re-litigated", async () => {
      const { failures } = await lintManifest();
      expect(failures.filter((f) => f.rule === "pos-wording")).toEqual([]);
      const { loadManifest } = await import("./db-migrations-core.mjs");
      const manifest = await loadManifest();
      const ids = manifest.migrations.map((m) => m.id);
      expect(ids).toContain(POS_WORDING_ID);
      // Earlier migrations really did publish the old words; the rule would
      // flag them, which is why it switches on only after the rename.
      const earlier = manifest.migrations.slice(0, ids.indexOf(POS_WORDING_ID));
      expect(earlier.some((m) => lintPosWording(m).length > 0)).toBe(true);
      // The rename itself publishes none of them.
      const rename = manifest.migrations[ids.indexOf(POS_WORDING_ID)];
      expect(lintPosWording(rename)).toEqual([]);
    });

    test("the rule has a name and an actionable message", () => {
      expect(POS_WORDING_RULE.name).toBe("pos-wording");
      expect(POS_WORDING_RULE.message).toMatch(/Write POS/);
    });
  });
});

describe("index-timestamp: a body write must move updated_at", () => {
  const mig = (id, sql) => ({ id, file: `sql/${id}.sql`, sql });
  const edit = (set) =>
    `UPDATE public.help_articles SET ${set} WHERE slug = 'g' AND strpos(body, $old$<p>x</p>$old$) > 0;`;

  test("★★ a replace() that leaves the timestamp alone is refused", () => {
    const findings = lintIndexTimestamps(
      mig(
        "x",
        edit("body = replace(body, $old$<p>x</p>$old$, $new$<p>y</p>$new$)"),
      ),
    );
    expect(findings.map((f) => f.rule)).toEqual([INDEX_TIMESTAMP_RULE.name]);
    expect(findings[0].sample).toMatch(/^UPDATE public\.help_articles/);
  });

  test("the same edit with updated_at = now() in the SET clause passes", () => {
    expect(
      lintIndexTimestamps(
        mig(
          "x",
          edit(
            "body = replace(body, $old$<p>x</p>$old$, $new$<p>y</p>$new$), updated_at = now()",
          ),
        ),
      ),
    ).toEqual([]);
  });

  test("an upsert's DO UPDATE half is held to the same rule; a plain INSERT is not", () => {
    const insert =
      "INSERT INTO public.help_articles (slug, body) VALUES ('g', $guide$<p>new guide</p>$guide$)";
    expect(lintIndexTimestamps(mig("x", `${insert};`))).toEqual([]);
    expect(
      lintIndexTimestamps(
        mig(
          "x",
          `${insert} ON CONFLICT (slug) DO UPDATE SET body = excluded.body;`,
        ),
      ).map((f) => f.rule),
    ).toEqual([INDEX_TIMESTAMP_RULE.name]);
    expect(
      lintIndexTimestamps(
        mig(
          "x",
          `${insert} ON CONFLICT (slug) DO UPDATE SET body = excluded.body, updated_at = now();`,
        ),
      ),
    ).toEqual([]);
  });

  test("the word body inside the guide's own copy, or a status-only update, does not count", () => {
    expect(
      lintIndexTimestamps(
        mig(
          "x",
          "UPDATE public.help_articles SET status = 'published' WHERE slug = 'g' AND body like '%updated_at = now()%';",
        ),
      ),
    ).toEqual([]);
    expect(
      lintIndexTimestamps(
        mig(
          "x",
          "UPDATE public.help_articles SET excerpt = $t$the body = of a guide$t$, updated_at = now() WHERE slug = 'g';",
        ),
      ),
    ).toEqual([]);
  });

  test("only help_articles writes are inspected, and a marker needs a reason", () => {
    expect(
      lintIndexTimestamps(
        mig("x", "UPDATE public.help_categories SET body = 'x';"),
      ),
    ).toEqual([]);
    const allowed = `-- help-lint: allow index-timestamp — an HTML comment only, nothing a reader or the index sees\n${edit(
      "body = replace(body, $old$<p>x</p>$old$, $new$<p>y</p>$new$)",
    )}`;
    expect(lintIndexTimestamps(mig("x", allowed))).toEqual([]);
  });

  test("★ the grandfather list is exactly the eight applied WhatsApp edits, and only they violate", async () => {
    expect([...GRANDFATHERED_INDEX_TIMESTAMP]).toEqual([
      "20261008_0178_whatsapp_inbox_help",
      "20261013_0193_whatsapp_cod_confirmation_help",
      "20261013_0194_whatsapp_stop_reply_help",
      "20261013_0196_whatsapp_cod_followup_retention_help",
      "20261013_0198_whatsapp_auto_replies_help",
      "20261014_0200_whatsapp_menu_buttons_help",
      "20261014_0201_whatsapp_template_manager_help",
      "20261014_0203_whatsapp_mink_help",
    ]);
    const { loadManifest } = await import("./db-migrations-core.mjs");
    const manifest = await loadManifest();
    const ids = new Set(manifest.migrations.map((m) => m.id));
    for (const id of GRANDFATHERED_INDEX_TIMESTAMP) {
      expect(ids.has(id), id).toBe(true);
      // Each one really does violate: a grandfather entry that excuses
      // nothing is one that outlives its reason.
      const migration = manifest.migrations.find((m) => m.id === id);
      expect(
        lintIndexTimestamps({ ...migration, id: `${id}:ungrandfathered` }),
        id,
      ).not.toEqual([]);
    }
  });
});
