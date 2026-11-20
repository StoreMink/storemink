import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// GUARD: the merchant dashboard never says how many Mink credits something
// costs or used (owner, 2026-10-18). No "· 5 credits" on a button, no
// "2 Mink credits were used" under a result, no price in a refusal.
//
// What it allows: the BALANCE (the chat's credit ring, "N Mink credits left")
// and Plans & Billing, where a merchant buys and reviews credits. Those say
// how many credits the store HAS, never what one action takes.
//
// Two checks over the code that renders dashboard text and the server
// messages it shows:
// - a literal or JSX text with a number of credits in it ("5 credits");
// - a rendered value naming a price (`expectedCredits`, `chargedCredits`, a
//   `*_CREDITS` constant) inside JSX or a template string.
// Comments and SQL (tagged templates) are not checked.
// ---------------------------------------------------------------------------

const ROOTS = [
  "app/dashboard",
  "app/pos",
  "app/actions",
  "components",
  "lib/mink",
  "lib/media",
  "lib/whatsapp",
];

const EXEMPT: { prefix: string; why: string }[] = [
  {
    prefix: "app/dashboard/plans/",
    why: "Plans & Billing: buying and reviewing credits is the point",
  },
  {
    prefix: "app/dashboard/(settings)/plans/",
    why: "the Plans & Billing pages, in the settings route group",
  },
  {
    prefix: "app/actions/ai-credit-actions.ts",
    why: "the credit-pack purchase behind Plans & Billing",
  },
  {
    prefix: "lib/mink/tools/",
    why: "tool declarations are read by the model, never shown; the prompt tells Mink not to quote prices",
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !full.includes(".test."))
      out.push(full);
  }
  return out;
}

const PRICE_TEXT = /\b\d+\s*(Mink\s+)?credits?\b/i;
const PRICE_NAME = /^(expectedCredits|chargedCredits)$|_CREDITS$/;

function namesPrice(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(child) && PRICE_NAME.test(child.text)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function priceHits(file: string, text: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const hits: string[] = [];
  const hit = (node: ts.Node, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    hits.push(`${file}:${line + 1}: ${what.trim().slice(0, 80)}`);
  };
  const visit = (node: ts.Node) => {
    // A tagged template is SQL (`sql\`... p_credits => ${X_CREDITS}\``):
    // the charge handed to the database, not text anyone reads.
    if (ts.isTaggedTemplateExpression(node)) return;
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      PRICE_TEXT.test(node.text)
    ) {
      hit(node, node.text);
    }
    if (ts.isJsxExpression(node) && node.expression && namesPrice(node)) {
      hit(node, node.getText(source));
      return;
    }
    if (ts.isTemplateSpan(node) && namesPrice(node.expression)) {
      hit(node, node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("no credit prices on the merchant dashboard", () => {
  // Parsing is the slow part (about 10 s for ~1,000 files under coverage), so
  // only files that mention a credit at all are parsed: every price this
  // looks for, text or name, contains "credit". The timeout matches
  // app/long-dash-coverage.test.ts, which hit the same limit.
  it(
    "never renders how many Mink credits something costs or used",
    {
      timeout: 30_000,
    },
    () => {
      const files = ROOTS.flatMap((root) => sourceFiles(root)).filter(
        (file) => !EXEMPT.some((rule) => file.startsWith(rule.prefix)),
      );
      expect(files.length).toBeGreaterThan(50);
      const hits = files.flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return /credit/i.test(text) ? priceHits(file, text) : [];
      });
      expect(hits).toEqual([]);
    },
  );

  it("catches a price on a button and in a message", () => {
    expect(
      priceHits(
        "x.tsx",
        "const b = <span>· {IMAGE_EDIT_CREDITS} credits</span>;",
      ),
    ).toHaveLength(1);
    expect(
      priceHits(
        "x.ts",
        "const m = `This uses ${IMAGE_EDIT_CREDITS} credits.`;",
      ),
    ).toHaveLength(1);
    expect(
      priceHits("x.tsx", "const t = <p>Uses 5 Mink credits.</p>;"),
    ).toHaveLength(1);
    // The balance is allowed.
    expect(
      priceHits("x.ts", "const m = `${totalLeft} Mink credits left`;"),
    ).toEqual([]);
  });
});
