import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import ts from "typescript";
import { findOldPosWording, sampleAround } from "../scripts/pos-wording.mjs";

// ---------------------------------------------------------------------------
// COVERAGE GUARD: the in-person selling feature is "POS" in text the product
// shows (owner's rule, 26 Oct 2026).
//
// "register" reads like signing up, and "till" is a second name for the same
// thing, so neither names POS anywhere: dashboard, POS screens, storefront,
// emails, Mink, operator console or marketing site. Inside the app it is "POS",
// not "Point of Sale"; the marketing site (app/platform outside its operator
// console) keeps "Point of Sale", written "Point of Sale (POS)" where it fits.
// "counter" stays wherever it is the physical shop counter, on every site.
//
// ★ BANNED BY DEFAULT. Every whole word register(s) or till(s) fails unless it
// is one of the other meanings the owner kept (scripts/pos-wording.mjs spells
// them out: registering a number, entity or template, signing up, "till" before
// a date). A list of banned phrase shapes let 22 of the 171 removed sentences
// back in when they were replayed, among them "Sell · Register" and the staff
// invite email, which is why there is no such list any more.
//
// Checked: string literals, whole template literals (`${…}` read as a
// placeholder) and the text of each JSX element with its expressions and
// inline children joined in, so "Sign in at your <strong>{x}</strong> register"
// is one sentence. Comments are not product text, and neither is a code value
// nobody reads: the sale kind "register", search words, log lines and SQL
// comments, each recognised by its place in the code, never by its words.
//
// The Help Centre is held to the same word list by the pos-wording rule in
// scripts/help-content-lint.mjs (migrations) and help-content-audit.mjs (the
// rows a database serves). The Mink and AI prompts read at runtime are
// markdown, checked below as whole files.
// ---------------------------------------------------------------------------

/** The product picture whose three screens say "Register". */
const PROMO_PICTURE = /storemink-pos-multidevice\.png/;

/**
 * The marketing sites keep "Point of Sale" (search titles, JSON-LD, the product
 * name). The operator console under app/platform/dashboard/ is app, not
 * marketing.
 */
function isMarketing(file: string): boolean {
  return (
    file.startsWith("app/platform/") &&
    !file.startsWith("app/platform/dashboard/")
  );
}

/**
 * Named lists of words people type to find a page or a guide: matched against
 * a search, never shown. HELP_SEARCH_ALIASES reading "till" as "pos" is how a
 * search for the old word still finds POS.
 */
const SEARCH_WORD_LISTS = new Set([
  "searchAliases:",
  "HELP_SEARCH_ALIASES =",
  "SHORT_TOPIC_WORDS =",
]);

/** Log lines: the logger's message, and the console line an email falls back to in development. */
const LOG_SPOT =
  /^(?:(?:log(?:Debug|Info|Warn|Error)|console\.(?:log|info|warn|error|debug))\(\)|devFallback:)$/;

/**
 * "Point of Sale" where nobody reads it. Exact text in an exact place: the
 * same words as a card title or a label beside it still fail.
 */
const ALLOWED_POINT_OF_SALE: {
  file: string;
  text: string;
  spot: string;
  within?: string;
  why: string;
}[] = [
  {
    file: "lib/settings/registry.ts",
    text: "Point of Sale",
    spot: "group:",
    why: "the settings group key, a filter that is never rendered",
  },
  {
    file: "app/dashboard/pos/settings/page.tsx",
    text: "Point of Sale",
    spot: "getStoreSettingsForEditor()",
    why: "the same settings group key, passed to getStoreSettingsForEditor",
  },
  {
    file: "lib/plans.ts",
    text: "Point of Sale (POS)",
    spot: "label:",
    within: "function planFeatureMatrix",
    why: "a row of the storemink.com /pricing matrix (planFeatureMatrix), marketing copy",
  },
];

/**
 * Legal sentences excused from the rule: none. The seven "register" sentences
 * of Privacy v3 and the old Terms v2 and AUP v2 drafts left lib/legal/content.ts
 * with the 26 Oct 2026 publish (migration 0255: Terms v2, Privacy v4 and
 * Acceptable Use v2, approved by a lawyer, which say POS), so legal text is
 * held to the rule like any other. Legal words change only with a new
 * lawyer-approved version; an entry here would excuse one exact sentence of a
 * published policy, and the staleness check below fails once it is gone.
 */
const LEGAL_PENDING: { file: string; phrase: string; why: string }[] = [];

/**
 * Prompts and task files read at runtime that shape what Mink and the AI
 * buttons write for a merchant (lib/mink/system-prompt.ts, whatsapp-prompt.ts,
 * image-prompt.ts; help-actions.ts and product-actions.ts).
 */
const PROMPT_FILES = [
  "docs/mink-ai-system-prompt.md",
  "docs/mink-ai-whatsapp-prompt.md",
  "docs/mink-ai-image-prompt.md",
  "brand/tasks/help-article.md",
  "brand/tasks/product-desc.md",
  "brand/tasks/seo-meta.md",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(full) && !full.includes(".test."))
      out.push(full);
  }
  return out;
}

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (full.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * What a piece of text says that the rule forbids, or null. Text only: the
 * places in code where a word is a value rather than copy are offendersIn's.
 */
function oldPosWording(file: string, text: string): string | null {
  if (PROMO_PICTURE.test(text)) return "the picture that says Register";
  const [hit] = findOldPosWording(text, { pointOfSale: !isMarketing(file) });
  return hit ? hit.words : null;
}

/** A stretch of a piece's text: its own words, or text checked elsewhere. */
interface Region {
  start: number;
  end: number;
  node: ts.Node | null;
}

/** What an expression inside a template or JSX contributes to the sentence. */
function placeholder(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
): string {
  if (!expression) return "";
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  )
    return expression.text;
  // "valid till ${formatDate(expiresAt)}" is a date, so "till" is "until".
  return /date|expir|until|_at\b|At\b/i.test(expression.getText(source))
    ? "{date}"
    : "{…}";
}

/** A JSX element's text, its expressions and inline children joined in. */
function jsxSentence(
  children: ts.NodeArray<ts.JsxChild>,
  source: ts.SourceFile,
): { text: string; regions: Region[] } {
  let text = "";
  const regions: Region[] = [];
  const push = (part: string, node: ts.Node | null) => {
    regions.push({ start: text.length, end: text.length + part.length, node });
    text += part;
  };
  for (const child of children) {
    if (ts.isJsxText(child)) push(child.text, child);
    else if (ts.isJsxExpression(child))
      push(placeholder(child.expression, source), null);
    else if (ts.isJsxElement(child) || ts.isJsxFragment(child))
      push(` ${jsxSentence(child.children, source).text} `, null);
    else push(" {…} ", null);
  }
  return { text, regions };
}

/** A template literal's text with each `${…}` as a placeholder. */
function templateSentence(
  node: ts.TemplateExpression,
  source: ts.SourceFile,
): { text: string; regions: Region[] } {
  let text = "";
  const regions: Region[] = [];
  const push = (part: string, owned: ts.Node | null) => {
    regions.push({
      start: text.length,
      end: text.length + part.length,
      node: owned,
    });
    text += part;
  };
  push(node.head.text, node);
  for (const span of node.templateSpans) {
    push(placeholder(span.expression, source), null);
    push(span.literal.text, node);
  }
  return { text, regions };
}

/**
 * The named places around a node, nearest first: "label:" for a property,
 * "NAME =" for a variable, "logWarn()" for a call it is an argument of,
 * "function name" for the function it sits in.
 */
function spotsOf(node: ts.Node, source: ts.SourceFile): string[] {
  const spots: string[] = [];
  let child: ts.Node = node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isPropertyAssignment(parent) && parent.initializer === child)
      spots.push(`${parent.name.getText(source)}:`);
    else if (ts.isVariableDeclaration(parent) && parent.initializer === child)
      spots.push(`${parent.name.getText(source)} =`);
    else if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.some((argument) => argument === child)
    )
      spots.push(
        `${ts.isNewExpression(parent) ? "new " : ""}${parent.expression.getText(source)}()`,
      );
    else if (
      (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name
    )
      spots.push(`function ${parent.name.getText(source)}`);
    child = parent;
  }
  return spots;
}

function insideJsx(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isJsxElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxFragment(parent) ||
      ts.isJsxExpression(parent) ||
      ts.isJsxAttribute(parent)
    )
      return true;
  }
  return false;
}

/** A value compared or typed, never shown: `kind === "register"`, `kind: "register" | "pickup"`. */
function comparedValue(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isLiteralTypeNode(parent) ||
    ts.isCaseClause(parent) ||
    (ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(parent.operatorToken.kind))
  );
}

/** SQL inside a sql`…` template: its -- comments are for the next engineer. */
function withoutSqlComments(node: ts.Node, text: string): string {
  const parent = node.parent;
  if (!parent || !ts.isTaggedTemplateExpression(parent)) return text;
  if (parent.tag.getText() !== "sql") return text;
  return text.replace(/--[^\n]*/g, (comment) => " ".repeat(comment.length));
}

/** A legal phrase as a pattern, so a line break inside it still matches. */
function phrasePattern(phrase: string): RegExp {
  return new RegExp(
    phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
    "g",
  );
}

/** Every forbidden piece of text in one file, as "file:line: words: text". */
function offendersIn(file: string, text: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const hits: string[] = [];
  const marketing = isMarketing(file);

  const report = (node: ts.Node, words: string, sample: string) => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    hits.push(
      `${file}:${line + 1}: "${words}" in ${sample.replace(/\s+/g, " ").trim().slice(0, 120)}`,
    );
  };

  const check = (
    node: ts.Node,
    sentence: string,
    regions: Region[] | null,
    { allowSaleKind = false } = {},
  ) => {
    const spots = spotsOf(node, source);
    if (spots.some((spot) => SEARCH_WORD_LISTS.has(spot))) return;
    if (spots.length > 0 && LOG_SPOT.test(spots[0])) return;
    if (PROMO_PICTURE.test(sentence)) {
      report(node, "the picture that says Register", sentence);
    }
    const checked = withoutSqlComments(node, sentence);
    for (const hit of findOldPosWording(checked, {
      pointOfSale: !marketing,
    })) {
      // A word wholly inside an inline child or a quoted expression is that
      // node's own to report; this one reports words in its own text and any
      // phrase that runs across the joins.
      let where: ts.Node = node;
      if (regions) {
        const end = hit.index + hit.words.length - 1;
        const first = regions.find(
          (r) => hit.index >= r.start && hit.index < r.end,
        );
        const last = regions.find((r) => end >= r.start && end < r.end);
        if (first === last && !first?.node) continue;
        if (first?.node) where = first.node;
      }
      if (allowSaleKind && hit.kind === "old-word" && sentence === "register")
        continue;
      if (
        hit.kind === "point-of-sale" &&
        ALLOWED_POINT_OF_SALE.some(
          (a) =>
            a.file === file &&
            sentence.trim() === a.text &&
            spots[0] === a.spot &&
            (!a.within || spots.includes(a.within)),
        )
      )
        continue;
      if (
        hit.kind === "old-word" &&
        LEGAL_PENDING.some(
          (a) =>
            a.file === file &&
            [...sentence.matchAll(phrasePattern(a.phrase))].some(
              (m) => hit.index >= m.index && hit.index < m.index + m[0].length,
            ),
        )
      )
        continue;
      report(
        where,
        hit.words,
        sampleAround(sentence, hit.index, hit.words.length),
      );
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      // A property name or an element key is an identifier, not text.
      const isKey =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isElementAccessExpression(parent) &&
          parent.argumentExpression === node);
      if (!isKey)
        check(node, node.text, null, {
          // The sale kind (orders.kind = 'register'): a database value, as
          // long as it is compared, typed or stays out of what JSX renders.
          allowSaleKind: !insideJsx(node) || comparedValue(node),
        });
    } else if (ts.isTemplateExpression(node)) {
      const { text: sentence, regions } = templateSentence(node, source);
      check(node, sentence, regions);
    } else if (
      (ts.isJsxElement(node) || ts.isJsxFragment(node)) &&
      node.children.some((child) => ts.isJsxText(child) && child.text.trim())
    ) {
      const { text: sentence, regions } = jsxSentence(node.children, source);
      check(node, sentence, regions);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

const CHEAP_FILTER =
  /\b(?:registers?|tills?|counter)\b|point[\s-]+of[\s-]+sale|pos-multidevice/i;

describe("★★ POS, never register or till, in product text", () => {
  const files = ["app", "components", "lib", "hooks"].flatMap((dir) =>
    sourceFiles(dir),
  );

  it("finds real files to scan, so a broken scan cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("every allowance still names real text in a real place", () => {
    for (const { file, text } of ALLOWED_POINT_OF_SALE) {
      expect(files.includes(file), file).toBe(true);
      expect(
        readFileSync(file, "utf8").includes(`"${text}"`),
        `${file}: ${text}`,
      ).toBe(true);
    }
    // When a new legal version replaces an excused sentence, drop it here: an
    // allowance for text that is gone would excuse the words coming back.
    for (const { file, phrase } of LEGAL_PENDING) {
      expect(
        readFileSync(file, "utf8").replace(/\s+/g, " ").includes(phrase),
        `${file}: ${phrase}`,
      ).toBe(true);
    }
    for (const file of PROMPT_FILES) {
      expect(statSync(file).isFile(), file).toBe(true);
    }
  });

  // The rule's own examples, so a pattern that drifts is caught here rather
  // than by a merchant. The first 21 rows are the 22 sentences (one twice) the
  // rename removed that the earlier list of banned phrases let back in.
  it.each([
    ["app/pos/sell/page.tsx", "Sell · Register"],
    ["app/pos/returns/page.tsx", "Returns · Register"],
    ["app/pos/pickups/page.tsx", "Pickups · Register"],
    ["app/dashboard/pos/pos-overview-client.tsx", "Open register"],
    [
      "app/dashboard/pos/pos-overview-client.tsx",
      "Register available at /pos on your store.",
    ],
    [
      "app/dashboard/pos/pos-overview-client.tsx",
      "StoreMink POS running across a desktop register, tablet, and phone with the real checkout interface",
    ],
    [
      "app/dashboard/admins/users-management-view.tsx",
      "Are you sure you want to remove this person? Their register sign-in will be deleted. This cannot be undone.",
    ],
    [
      "app/pos/register/register-client.tsx",
      "account is ready. Sign in at your shop&apos;s register with",
    ],
    [
      "app/pos/reset/reset-client.tsx",
      "Sign in at your shop&apos;s register with",
    ],
    ["app/pos/shift/shift-client.tsx", "e.g. 50 short, till jam at 3pm"],
    ["lib/email/account-emails.ts", "register."],
    ["lib/email/account-emails.ts", "</strong> register."],
    [
      "lib/email/email-samples.ts",
      "<p>You can now sell in person with the new register. It shares stock, customers and offers with your online store.</p>",
    ],
    ["lib/email/email-samples.ts", "Meet the StoreMink register"],
    [
      "app/platform/dashboard/(console)/roles-console.tsx",
      "Register capabilities (set in code)",
    ],
    ["app/platform/dashboard/(console)/stores/[storeId]/page.tsx", "till"],
    ["app/platform/dashboard/(console)/stores/[storeId]/page.tsx", "till)"],
    [
      "app/platform/pos/page.tsx",
      "StoreMink POS turns the devices you already own into a fast retail register, and keeps every checkout in one system.",
    ],
    ["app/platform/product-art.tsx", "Main shop · Till 1"],
    ["app/dashboard/pos/settings/page.tsx", "Point of Sale"],
    ["lib/settings/registry.ts", "Point of Sale"],
    [
      "lib/settings/registry.ts",
      "Enable Point of Sale at /pos. Lock the register after.",
    ],
    ["app/dashboard/x.tsx", "Register"],
    ["app/pos/x.tsx", "Lock the register"],
    ["app/dashboard/x.tsx", "Invite register staff from your dashboard."],
    ["app/dashboard/x.tsx", "Every till"],
    ["lib/plans.ts", "Authorised tills per location"],
    ["app/platform/pos/page.tsx", "A register your team can learn"],
    ["app/dashboard/x.tsx", "Register number 2"],
    ["app/dashboard/x.tsx", "Turn on Point of Sale"],
    ["lib/mink/x.ts", "All sales, online store sales, or point-of-sale sales."],
    ["app/dashboard/x.tsx", "Run counter sales"],
    ["app/platform/page.tsx", "Website orders, counter sales and pickups"],
    ["app/platform/pos/page.tsx", "Website + counter stock in sync"],
    ["lib/x.ts", "A real account wins over a till-created profile."],
    ["app/platform/page.tsx", 'src="/brand/storemink-pos-multidevice.png"'],
  ])("flags %s: %s", (file, text) => {
    expect(oldPosWording(file, text)).not.toBeNull();
  });

  // Other meanings the owner kept must pass: signing up, GST and DLT
  // registration, a WhatsApp number, the registered office, "till" meaning
  // until, the physical counter, routes and class names.
  it.each([
    ["lib/x.ts", "/pos/register?token="],
    ["app/x.tsx", "posx-ui posx-register-ui"],
    ["app/x.tsx", "./register-client"],
    ["app/x.tsx", "Complete registration"],
    ["app/x.tsx", "Email an offer to all registered customers."],
    ["app/x.tsx", "Add your GST registration number."],
    [
      "lib/x.ts",
      "Register a Principal Entity and a 6-character sender header on the DLT portal.",
    ],
    [
      "app/x.tsx",
      "Every business must register its own entity, sender header and message templates.",
    ],
    ["lib/x.ts", "Meta refused to register the number."],
    ["app/x.tsx", "Sign in or register to see your orders."],
    ["app/x.tsx", "Registered office: Faridkot, Punjab, India"],
    ["app/x.tsx", "till 31 March"],
    ["app/x.tsx", "Valid till 5pm."],
    ["app/x.tsx", "Pay at the counter when you collect your order."],
    ["app/x.tsx", "Nothing is on hold at this counter."],
    ["app/x.tsx", "StoreMink POS (point of sale)"],
    ["app/x.tsx", "https://help.storemink.com/help/point-of-sale/enable-pos"],
    ["app/platform/pos/page.tsx", "Point of Sale is included with Pro"],
    [
      "app/platform/page.tsx",
      "Your website and your counter, on the same page.",
    ],
  ])("leaves %s alone: %s", (file, text) => {
    expect(oldPosWording(file, text)).toBeNull();
  });

  // The same rule run over code, so the places that make a word a value
  // rather than copy are tested where they are recognised.
  it.each([
    [
      "lib/email/account-emails.ts",
      "const html = `Sign in at your shop's <strong>${name}</strong> register.`;",
    ],
    [
      "app/platform/dashboard/(console)/stores/[storeId]/page.tsx",
      'const x = <span>{p.kind === "pos" ? "till" : "web"}</span>;',
    ],
    [
      "app/dashboard/x.tsx",
      "const x = <p>Open <strong>{name}</strong> register</p>;",
    ],
    ["app/dashboard/x.tsx", 'const x = <p>{"register"}</p>;'],
    ["app/dashboard/x.tsx", 'const x = <p>Point of{" "}Sale</p>;'],
    [
      "lib/settings/registry.ts",
      'const s = { group: "Point of Sale", label: "Point of Sale" };',
    ],
    [
      "app/dashboard/pos/settings/page.tsx",
      'const x = <Card title="Point of Sale" />;',
    ],
    [
      "lib/plans.ts",
      'const rows = [{ label: "Point of Sale (POS)", pro: true }];',
    ],
    ["app/dashboard/x.tsx", "const x = <div>Till {device.number}</div>;"],
    ["lib/legal/content.ts", "const t = `You may use the register.`;"],
    // Privacy v3's sentence, excused until the 26 Oct 2026 legal publish.
    [
      "lib/legal/content.ts",
      "const t = `Staff data: for people you invite to the dashboard or a register, their name.`;",
    ],
    ["app/x.tsx", 'export const metadata = { keywords: ["till", "POS"] };'],
  ])("flags code in %s: %s", (file, code) => {
    expect(offendersIn(file, code)).not.toEqual([]);
  });

  it.each([
    ["lib/x.ts", 'type Kind = { kind: "register" | "pickup" };'],
    ["lib/x.ts", 'const kind = picked ? "pickup" : "register";'],
    [
      "app/x.tsx",
      'const x = <p>{r.kind === "register" ? "POS sale" : "Pickup"}</p>;',
    ],
    [
      "app/dashboard/lib/x.ts",
      'const s = { searchAliases: ["point of sale", "register", "till"] };',
    ],
    ["lib/x.ts", 'const HELP_SEARCH_ALIASES = { pos: ["register", "till"] };'],
    ["lib/x.ts", 'const SHORT_TOPIC_WORDS = new Set(["register", "till"]);'],
    [
      "lib/x.ts",
      'logWarn("register offers unavailable - migration not applied");',
    ],
    [
      "app/actions/x.ts",
      "send({ devFallback: `Email: ${to}\\nRegister: ${link}` });",
    ],
    [
      "lib/x.ts",
      "await db.execute(sql`select 1 -- a till-created pos_ row\n from users`);",
    ],
    ["app/x.tsx", "const x = <div>till {formatDate(s.plan_expires_at)}</div>;"],
    [
      "app/x.tsx",
      "const x = s.plan_expires_at ? ` (till ${formatDate(s.plan_expires_at)})` : '';",
    ],
    [
      "lib/settings/registry.ts",
      'const s = [{ group: "Point of Sale", label: "POS" }];',
    ],
    [
      "app/dashboard/pos/settings/page.tsx",
      'const r = getStoreSettingsForEditor("Point of Sale");',
    ],
    [
      "lib/plans.ts",
      'export function planFeatureMatrix() { return [{ label: "Point of Sale (POS)" }]; }',
    ],
    // Terms v2: registering the domain with search engines, a kept meaning.
    [
      "lib/legal/content.ts",
      "const t = `once your store is open we register it with search engines under our account.`;",
    ],
  ])("leaves code in %s alone: %s", (file, code) => {
    expect(offendersIn(file, code)).toEqual([]);
  });

  // Parses only files that mention one of the words, so it stays fast.
  it(
    "says POS where the old words named it",
    {
      timeout: 30_000,
    },
    () => {
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        if (!CHEAP_FILTER.test(text)) continue;
        offenders.push(...offendersIn(file, text));
      }
      expect(
        offenders,
        'The in-person selling feature is "POS" (owner, 26 Oct 2026): "in POS", "a POS sale", ' +
          '"POS staff", "POS device", "sign in to POS". Marketing pages may say "Point of Sale". ' +
          "The multidevice picture says Register on its screens: replace the file (same name " +
          "and size, screens saying Sell) before showing it again, then drop that pattern here.",
      ).toEqual([]);
    },
  );

  it("the Mink and AI prompts read at runtime say POS too", () => {
    const offenders: string[] = [];
    for (const file of PROMPT_FILES) {
      // A short quote or a code span is a mention, not a use: an instruction
      // may tell Mink never to write "register".
      const text = readFileSync(file, "utf8")
        .replace(/`[^`\n]{0,40}`/g, " ")
        .replace(/["“]\s*[\w'-]+(?:\s+[\w'-]+){0,2}\s*["”]/g, " ");
      for (const hit of findOldPosWording(text))
        offenders.push(
          `${file}: "${hit.words}" in ${sampleAround(text, hit.index, hit.words.length)}`,
        );
    }
    expect(offenders).toEqual([]);
  });

  it("no stylesheet shows the picture that says Register", () => {
    const offenders = ["app", "components"]
      .flatMap((dir) => cssFiles(dir))
      .filter((file) => PROMO_PICTURE.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
