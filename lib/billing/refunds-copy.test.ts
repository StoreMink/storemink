import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import ts from "typescript";

// ---------------------------------------------------------------------------
// No em dash (U+2014) and no en dash (U+2013) in the text of the renewal and
// cancellation work (design section 11.1, review finding 9).
//
// app/long-dash-coverage.test.ts checks the whole product for U+2014 only, and
// 55 existing product files still use U+2013 in ranges, so widening that guard
// is a separate change. This one holds the house rule, both dashes, for the
// files of this design (its section 15): the string literals, template text
// and JSX text, with the same parser that guard uses. Comments are not product
// text and are not checked.
//
// Every file listed must exist: a renamed or deleted file is a gap in the
// guard, not a pass.
//
// Stage 9b appended the merchant's Plans & Billing screens that stage 8b made
// or changed (the plans page, the invoices list and its test, the invoice and
// credit-note sheets, refunds-notice.tsx, the credit-note page and their
// tests), the operator's Refunds page, its table and credit-note page, the
// Billing & tax page and form, the store page and its billing tools, and the
// reconciliation queue and page. Stage 8a's action file
// (subscribe-actions.ts) is listed already.
//
// Left out on purpose: changed test files whose OWN existing titles or
// assertions already carry an em dash from before this design
// (renewal-worker, cancel, collect, payment-state, invoice-store, manual-pay,
// reconcile, invoice-history, platform-settings, billing-emails and the
// billing cron route's tests, the merchant invoice sheet's test and the
// reconciliation queue's test). Their new cases follow the rule; cleaning the
// old titles is not this design's change.
// ---------------------------------------------------------------------------

const FILES = [
  // New (stages 1 to 7, and 9a)
  "lib/billing/close-cycle.ts",
  "lib/billing/close-cycle.test.ts",
  "lib/billing/refunds.ts",
  "lib/billing/refunds.test.ts",
  "lib/billing/refunds.local.test.ts",
  "lib/billing/refunds-migration.test.ts",
  "lib/billing/refunds-copy.test.ts",
  "lib/billing/credit-notes.ts",
  "lib/billing/credit-notes.test.ts",
  "lib/billing/credit-note-store.ts",
  "lib/billing/credit-note-store.test.ts",
  "app/actions/platform-billing.ts",
  "app/actions/platform-billing.test.ts",
  // Changed
  "lib/billing/renewal-worker.ts",
  "lib/billing/cancel.ts",
  "lib/billing/collect.ts",
  "lib/billing/payment-state.ts",
  "lib/billing/invoice-store.ts",
  "lib/billing/manual-pay.ts",
  "lib/billing/reconcile.ts",
  "lib/billing/invoice-history.ts",
  "lib/billing/invoice-types.ts",
  "lib/billing/platform-settings.ts",
  "lib/billing/receipts.ts",
  "lib/billing/receipts.test.ts",
  "lib/billing/invoice-retention.local.test.ts",
  "lib/email/billing-emails.ts",
  "lib/platform/store-detail.ts",
  "app/actions/platform.ts",
  "app/actions/platform.test.ts",
  "app/actions/subscribe-actions.ts",
  "app/api/cron/billing/route.ts",
  // Stage 8b: the merchant's Plans & Billing screens
  "app/dashboard/plans/page.tsx",
  "app/dashboard/plans/invoices/page.tsx",
  "app/dashboard/plans/invoices/page.test.tsx",
  "app/dashboard/plans/invoices/invoice-sheet.tsx",
  "app/dashboard/plans/refunds-notice.tsx",
  "app/dashboard/plans/refunds-notice.test.tsx",
  "app/dashboard/plans/credit-notes/[id]/page.tsx",
  "app/dashboard/plans/credit-notes/[id]/page.test.tsx",
  "app/dashboard/plans/credit-notes/credit-note-sheet.tsx",
  "app/dashboard/plans/credit-notes/credit-note-sheet.test.tsx",
  // Stage 9b: the operator console (new)
  "app/platform/dashboard/(console)/billing/refunds/page.tsx",
  "app/platform/dashboard/(console)/billing/refunds/refunds-table.tsx",
  "app/platform/dashboard/(console)/billing/refunds/refunds-table.test.tsx",
  "app/platform/dashboard/(console)/billing/credit-notes/[id]/page.tsx",
  "app/platform/dashboard/(console)/billing/credit-notes/[id]/page.test.tsx",
  "app/platform/dashboard/(console)/billing/page.test.tsx",
  "app/platform/dashboard/(console)/stores/[storeId]/billing-actions.tsx",
  "app/platform/dashboard/(console)/stores/[storeId]/billing-actions.test.tsx",
  // Stage 9b: the operator console (changed)
  "app/platform/dashboard/(console)/billing/page.tsx",
  // GST Stage 11 moved the refunds switch out of the deleted
  // tax-settings-form.tsx into its own card, with the same text.
  "app/platform/dashboard/(console)/billing/refund-settings.tsx",
  "app/platform/dashboard/(console)/stores/[storeId]/page.tsx",
  "app/platform/dashboard/(console)/billing/reconciliation/queue.tsx",
  "app/platform/dashboard/(console)/billing/reconciliation/page.tsx",
];

// Built from code points so this file cannot match itself.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

function hasDash(text: string): boolean {
  return text.includes(EM_DASH) || text.includes(EN_DASH);
}

/** Every long dash inside a literal the product could render, as "file:line". */
function literalDashes(file: string, text: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      hasDash(node.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      hits.push(`${file}:${line + 1}: ${node.text.trim().slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("no em or en dash in the renewal and cancellation texts", () => {
  it("every listed file exists, so a moved file cannot pass silently", () => {
    const missing = FILES.filter((file) => !existsSync(file));
    expect(missing).toEqual([]);
  });

  it("the scan finds a dash where there is one", () => {
    expect(literalDashes("probe.ts", `const a = "1${EN_DASH}2";`)).toHaveLength(
      1,
    );
    expect(
      literalDashes("probe.tsx", `const a = <p>Paid ${EM_DASH} thanks</p>;`),
    ).toHaveLength(1);
    expect(
      literalDashes("probe.ts", `// a comment ${EM_DASH} is not text`),
    ).toEqual([]);
  });

  it(
    "uses a hyphen, comma, colon or the word 'to' instead",
    { timeout: 30_000 },
    () => {
      const offenders: string[] = [];
      for (const file of FILES) {
        if (!existsSync(file)) continue;
        const text = readFileSync(file, "utf8");
        // Escaped forms count too: they render as the same character.
        if (
          !hasDash(text) &&
          !text.includes("\\u2014") &&
          !text.includes("\\u2013")
        ) {
          continue;
        }
        offenders.push(...literalDashes(file, text));
      }
      expect(
        offenders,
        'Billing copy never uses an em or en dash. Write " - ", a comma or a ' +
          'colon in a sentence, and "5 to 7" for a range.',
      ).toEqual([]);
    },
  );
});
