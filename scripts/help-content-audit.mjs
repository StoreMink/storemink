#!/usr/bin/env node

/**
 * Audits the Help Centre rows a database is actually serving.
 *
 * `help:lint` reads migration SQL and runs in CI. It cannot see two things:
 * content an operator edited in the Help console, and the assembled result of
 * many migrations appending to one guide -- which is how
 * `use-mink-ai-in-your-dashboard` reached 69 KB and 36 sections without any
 * single migration looking unreasonable.
 *
 * This reads the published rows and reports the same banned vocabulary, plus
 * the two shape numbers that flag a guide turning back into a changelog:
 * length and section count. Every field the Help console edits is read: title,
 * excerpt, body, SEO title and SEO description, and the category titles and
 * descriptions; so are the platform roles' names and descriptions, which a
 * merchant reads when choosing a role. Categories and roles get the copy rules
 * only (em dash, POS wording).
 *
 * NOT IN CI, for the reason `db:drift` is not: it needs database credentials,
 * and a pull request cannot cause published-content drift. Run it after a
 * Help migration and when reviewing the Help Centre:
 *
 *   npm run help:audit:local     (or :staging / :prod)
 *
 * Exit 1 on any banned vocabulary. Oversized guides are reported as warnings,
 * because length is a judgement rather than a defect -- one long guide with a
 * good reason should not fail a release.
 */

import process from "node:process";
import pg from "pg";
import {
  HELP_LINT_RULES,
  LONG_DASH_RULE,
  POS_WORDING_RULE,
} from "./help-content-lint.mjs";

// Published rows are held to the em dash rule and the POS wording rule too: a
// guide edited in the Help console never passes through a migration, so only
// this can catch one.
const AUDIT_RULES = [...HELP_LINT_RULES, LONG_DASH_RULE, POS_WORDING_RULE];

// Operators also edit the Help categories (title, description) and the
// platform roles a merchant picks from (name, description: storemink.com/
// dashboard/roles). Neither is a guide, so only the copy rules apply.
const COPY_RULES = [LONG_DASH_RULE, POS_WORDING_RULE];

const { Client } = pg;

/** A guide past these has usually become a changelog rather than a guide. */
const MAX_CHARS = 25_000;
const MAX_SECTIONS = 14;

/**
 * Comments are stripped before rendering, search indexing and AI retrieval, so
 * they are not published text. 20260910_0093 uses one to satisfy a durable
 * postcondition that can no longer be edited; docs/help-centre.md explains.
 */
function renderedText(body) {
  return (body ?? "").replace(/<!--[\s\S]*?-->/g, " ");
}

function config() {
  const adminUser = process.env.DB_ADMIN_USER;
  if (!adminUser) throw new Error("DB_ADMIN_USER is required");
  const host = process.env.DB_HOST;
  const isSocket = host?.startsWith("/");
  return {
    host,
    port: isSocket ? undefined : Number(process.env.DB_PORT ?? 5432),
    user: adminUser,
    password: process.env.DB_ADMIN_PASSWORD,
    database: process.env.DB_NAME,
    ssl: false,
    application_name: "storemink-help-audit",
  };
}

async function main() {
  const client = new Client(config());
  await client.connect();
  let rows;
  let categories;
  let roles;
  try {
    // The SEO title and description are what a search engine shows for the
    // guide, and the Help console edits them like the body.
    ({ rows } = await client.query(
      `select a.slug, a.title, a.excerpt, a.body, a.seo_title,
              a.seo_description
         from public.help_articles a
        where a.status = 'published'
        order by a.slug`,
    ));
    ({ rows: categories } = await client.query(
      `select slug, title, description from public.help_categories
        order by slug`,
    ));
    ({ rows: roles } = await client.query(
      `select slug, name, description from public.platform_roles
        order by slug`,
    ));
  } finally {
    await client.end();
  }

  const failures = [];
  const warnings = [];
  for (const row of rows) {
    const text = renderedText(
      [row.title, row.excerpt, row.body, row.seo_title, row.seo_description]
        .map((field) => field ?? "")
        .join("\n"),
    );
    for (const rule of AUDIT_RULES) {
      const hit = text.match(rule.pattern);
      if (hit)
        failures.push({
          slug: row.slug,
          rule: rule.name,
          sample: hit[0].trim(),
        });
    }
    const chars = (row.body ?? "").length;
    const sections = (row.body ?? "").split("<h2>").length - 1;
    if (chars > MAX_CHARS || sections > MAX_SECTIONS) {
      warnings.push({ slug: row.slug, chars, sections });
    }
  }
  const copy = [
    ...categories.map((c) => ({
      slug: `category ${c.slug}`,
      text: `${c.title}\n${c.description ?? ""}`,
    })),
    ...roles.map((r) => ({
      slug: `role ${r.slug}`,
      text: `${r.name}\n${r.description ?? ""}`,
    })),
  ];
  for (const { slug, text } of copy) {
    for (const rule of COPY_RULES) {
      const hit = text.match(rule.pattern);
      if (hit) failures.push({ slug, rule: rule.name, sample: hit[0].trim() });
    }
  }

  console.log(
    `Audited ${rows.length} published guides, ${categories.length} categories and ${roles.length} platform roles in ${process.env.DB_NAME}.`,
  );
  if (warnings.length) {
    console.log(`\n${warnings.length} oversized guide(s) — split by task:`);
    for (const w of warnings.sort((a, b) => b.chars - a.chars)) {
      console.log(
        `  ${w.slug}: ${w.chars.toLocaleString()} chars, ${w.sections} sections` +
          ` (guide limits ${MAX_CHARS.toLocaleString()} / ${MAX_SECTIONS})`,
      );
    }
  }
  if (failures.length === 0) {
    console.log(
      "\nNo operator-only or internal vocabulary in published content.",
    );
    return;
  }
  console.error(
    `\n${failures.length} finding(s) in published content a merchant cannot act on or should not read:`,
  );
  const byRule = new Map();
  for (const f of failures) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  for (const [rule, list] of byRule) {
    const def = AUDIT_RULES.find((r) => r.name === rule);
    console.error(`\n  [${rule}] ${def.message}`);
    for (const f of list)
      console.error(`      ${f.slug} — found ${JSON.stringify(f.sample)}`);
  }
  console.error(
    "\nFix with a forward-only migration in drizzle/migrations/sql/. See docs/help-centre.md.",
  );
  process.exitCode = 1;
}

await main();
