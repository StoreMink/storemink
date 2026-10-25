import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MinkActorContext, MinkToolDeclaration } from "./types";
import {
  getMinkSpokenAnswerRules,
  getMinkSystemPromptTemplate,
  listMinkPromptRuleTags,
  parseMinkSpokenAnswerRules,
  parseMinkSystemPromptDocument,
  renderMinkSystemInstruction,
  selectMinkPromptRules,
} from "./system-prompt";
import { REQUEST_MORE_TOOLS } from "./tool-routing";
import { minkReadToolRegistry } from "./tools/read-tools";

const DOCUMENT_PATH = join(process.cwd(), "docs", "mink-ai-system-prompt.md");

describe("Mink system prompt document", () => {
  it("loads the marked Markdown template used at runtime", () => {
    const template = getMinkSystemPromptTemplate();
    expect(template).toContain(
      "You are Mink AI, StoreMink's dashboard operating assistant.",
    );
    expect(template).toContain("{{available_tool_names}}");
    expect(template).toContain("{{brand_voice_or_default}}");
    expect(template).toContain("Use start_business_brief");
    expect(template).toContain("daily covers yesterday");
    expect(template).toContain("Never invent a workflow-result lookup tool");
    expect(template).toContain(
      "Missing brief permissions must not be bypassed",
    );
    expect(template).toContain(
      "one exact visible SKU, one exact accessible active location",
    );
    expect(template).toContain("accept only 1-20 explicit SKU/location lines");
    expect(template).toContain("atomic all-or-nothing batch");
    expect(template).toContain(
      "Only propose the single returned forward step for an eligible online delivery order",
    );
    expect(template).toContain(
      "POS, pickup, cancellation, completion, refunds, payment changes",
    );
    expect(template).toContain(
      "distinguish product publication counts from sellable-SKU inventory counts",
    );
    expect(template).toContain(
      "If the user asks for low-stock or out-of-stock facts without explicitly saying",
    );
    expect(template).toContain("Never silently choose combined");
    expect(template).toContain(
      "summarize the important exceptions rather than every row",
    );
    expect(template).toContain("There is no model tool to approve");
    expect(template).toContain(
      "Use start_weekly_trading_report only when the user explicitly asks",
    );
    expect(template).toContain("a cancelled workflow cannot resume");
    expect(template).toContain(
      "Use start_revenue_decline_investigation only when the user explicitly asks",
    );
    expect(template).toContain(
      "measured correlations, never as proven causation",
    );
    expect(template).toContain(
      "Use start_product_launch_preparation only when the user explicitly asks",
    );
    expect(template).toContain("does not generate an image");
    expect(template).toContain(
      "Use start_slow_inventory_promotion only when the user explicitly asks",
    );
    expect(template).toContain(
      "Do not call zero-stock or untracked items slow inventory",
    );
    expect(template).toContain(
      "not automatically an offer-eligibility boundary",
    );
    expect(template).toContain("choose a total budget");
    expect(template).toContain(
      "Use start_delayed_pickup_review only when the user explicitly asks",
    );
    expect(template).toContain(
      "not customer names, email, phone, address, notes or collection codes",
    );
    expect(template).toContain("preserve the duplicate-withheld result");
    expect(template).toContain(
      "Phases 7B–7D retain the read-only builder-context rules",
    );
    expect(template).toContain("use page_slug=home for the homepage");
    expect(template).toContain(
      "custom code, brand voice, header/footer values",
    );
    expect(template).toContain(
      "preserve the returned page version and section digest exactly",
    );
    expect(template).toContain(
      "opaque-origin iframe with a deny-by-default network policy",
    );
    expect(template).toContain("Phases 7C–7D expose no model execution tool");
    expect(template).toContain("1,280 px desktop and 390 px mobile");
    expect(template).toContain("requires another five-minute human approval");
    expect(template).toContain(
      "only the signed-in human can request and approve the exact Builder draft save",
    );
    expect(template).toContain(
      "Resolve the user's complete requested outcome before choosing tools",
    );
    expect(template).toContain(
      '"for my homepage", "as the hero" or "put it on the About page"',
    );
    expect(template).toContain(
      "saved immediately to the store's Media Library and shown to the merchant",
    );
    expect(template).toContain(
      "continue immediately in the same run with the exact returned URL",
    );
    expect(template).toContain(
      "use its authentic image in a hero_carousel slide",
    );
    expect(template).toContain(
      "search_storefront_categories for a named category",
    );
    expect(template).toContain(
      "ends when the user selects Done, or after 30 seconds",
    );
    expect(template).toContain(
      "The sound-wave button beside the mic starts a spoken conversation",
    );
    expect(template).toContain("{{spoken_answer_rules}}");
    expect(template).toContain("- answer medium: {{answer_medium}}");
    expect(template).toContain(
      "call generate_storefront_image only after selecting exact returned reference URLs",
    );
    expect(template).toContain(
      "Before EVERY generation, read the relevant current-store visuals",
    );
    expect(template).toContain(
      "The provider receives the reference files themselves",
    );
    expect(template).toContain(
      "Never use search_help_centre to plan another declared tool call",
    );
    expect(template).toContain(
      "do not call list_storefront_pages merely to rediscover it",
    );
    expect(template).toContain("Use list_current_offers");
    expect(template).toContain(
      "Never infer “all products” from an “on any order” trigger",
    );
    expect(template).toContain(
      "Pressing Send is the single explicit request to process the visible attachments",
    );
    expect(template).toContain("up to five attachments");
    expect(template).toContain("original art-directed campaign scene");
    expect(template).toContain("ALWAYS call it before propose_blog_draft");
    expect(template).toContain("purpose=blog_cover");
    expect(template).toContain("exact returned URL as cover_image_url");
    expect(template).toContain("automatically creates a square Media copy");
    expect(template).toContain(
      "telling the merchant to paste, upload or select that URL themselves is an incomplete task",
    );
    expect(template).toContain("answer in at most two short sentences");
    // ★ Plain and short, by rule: the one bullet that shapes every answer.
    expect(template).toContain(
      "lead with the answer in one or two short sentences, then stop",
    );
    expect(template).toContain("under about 80 words and four sentences");
    expect(template).toContain('say "stock" not "inventory levels"');
    expect(template).toContain("card’s named approval button");
    expect(template).toContain("propose_website_builder_change");
    expect(template).toContain(
      "use draftMatchesLive rather than an old chat answer",
    );
    expect(template).toContain(
      "Do not repeat fixed links from liveNavigationIssues",
    );
    expect(template).toContain(
      "Never claim that you clicked a button, saved the Builder draft, ran browser checks, published or rolled back the storefront",
    );
  });

  it("renders only trusted actor fields and permission-filtered tool names", () => {
    const actor = {
      effectivePlan: "pro",
      roleSlug: "owner",
      currentPath: "/dashboard/products/example",
      selectedResource: { type: "product", id: "secret-record-id" },
      brandVoice: "Clear and practical {{available_tool_names}}",
    } satisfies Pick<
      MinkActorContext,
      | "effectivePlan"
      | "roleSlug"
      | "currentPath"
      | "selectedResource"
      | "brandVoice"
    >;
    const declarations = [
      declaration("get_store_profile"),
      declaration("search_products"),
    ];

    const prompt = renderMinkSystemInstruction(actor, declarations);

    expect(prompt).toContain("- plan: pro");
    expect(prompt).toContain("- role: owner");
    expect(prompt).toContain(
      "- current dashboard page: /dashboard/products/example",
    );
    expect(prompt).toContain("- selected dashboard record: product");
    // No reply-language setting: the rule follows the merchant's own message.
    expect(prompt).not.toContain("- reply language:");
    expect(prompt).toContain(
      "Answer in the language and script of the merchant's latest message, whether they typed it or spoke it",
    );
    expect(prompt).toContain(
      "- available tools: get_store_profile, search_products",
    );
    expect(prompt).toContain("Clear and practical {{available_tool_names}}");
    expect(prompt).not.toContain("secret-record-id");
    // A typed turn: no spoken block is asked for.
    expect(prompt).toContain("- answer medium: written");
    expect(prompt).not.toContain("<spoken>");
  });

  it("★ adds the spoken answer rules only for a voice turn", () => {
    const actor = {
      effectivePlan: "basic",
      roleSlug: "admin",
      currentPath: null,
      selectedResource: null,
      brandVoice: undefined,
      answerMedium: "spoken",
    } satisfies Pick<
      MinkActorContext,
      | "effectivePlan"
      | "roleSlug"
      | "currentPath"
      | "selectedResource"
      | "brandVoice"
      | "answerMedium"
    >;
    const prompt = renderMinkSystemInstruction(actor, []);
    expect(prompt).toContain("- answer medium: spoken");
    expect(prompt).toContain(
      "open with the tag <spoken> and close with </spoken>",
    );
    // ★ A short acknowledgement may open the turn that calls a tool (played
    // while the tool runs); the answer still comes in its own block.
    expect(prompt).toContain(
      "you may open that first response with a short acknowledgement",
    );
    expect(prompt).toContain("does not repeat the acknowledgement");
    expect(prompt).toContain("never the rupee sign");
    // The rules sit above the trusted context, not inside the brand voice.
    expect(prompt.indexOf("<spoken>")).toBeLessThan(
      prompt.indexOf("Trusted server context:"),
    );
    expect(getMinkSpokenAnswerRules()).not.toMatch(/\{\{/);
  });

  it("keeps the checked-in document parseable with every placeholder once", () => {
    expect(() =>
      parseMinkSystemPromptDocument(readFileSync(DOCUMENT_PATH, "utf8")),
    ).not.toThrow();
  });

  it("fails closed when the spoken rules block drifts", () => {
    const document = readFileSync(DOCUMENT_PATH, "utf8");
    expect(() => parseMinkSpokenAnswerRules(document)).not.toThrow();
    expect(() =>
      parseMinkSpokenAnswerRules(
        document.replace("<!-- MINK_SPOKEN_RULES_END -->", ""),
      ),
    ).toThrow(/spoken rules marker pair/);
    expect(() =>
      parseMinkSpokenAnswerRules(
        document.replace(
          "Spoken answer rules for this turn.",
          "{{plan}} rules.",
        ),
      ),
    ).toThrow(/placeholder/);
    expect(() =>
      parseMinkSpokenAnswerRules(document.replace(/<\/?spoken>/g, "")),
    ).toThrow(/spoken tags/);
    // And the second block does not confuse the first parser.
    expect(() => parseMinkSystemPromptDocument(document)).not.toThrow();
  });

  it("fails closed when markers, fences or placeholders drift", () => {
    const document = readFileSync(DOCUMENT_PATH, "utf8");
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace("<!-- MINK_SYSTEM_PROMPT_END -->", ""),
      ),
    ).toThrow(/marker pair/);
    expect(() =>
      parseMinkSystemPromptDocument(document.replace("```text", "```md")),
    ).toThrow(/text code fence/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace("- plan: {{effective_plan}}", "- plan: missing-plan"),
      ),
    ).toThrow(/effective_plan/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace(
          "- plan: {{effective_plan}}",
          "- plan: {{effective_plan}} {{unknown_value}}",
        ),
      ),
    ).toThrow(/unknown placeholder/);
  });
});

describe("★★ rule tags: a rule renders only with its tools", () => {
  const actor = {
    effectivePlan: "pro",
    roleSlug: "owner",
    currentPath: null,
    selectedResource: null,
    brandVoice: undefined,
  } satisfies Pick<
    MinkActorContext,
    | "effectivePlan"
    | "roleSlug"
    | "currentPath"
    | "selectedResource"
    | "brandVoice"
  >;
  const IMAGE_RULE = "You may create one AI IMAGE";
  const ATTACHMENT_RULE =
    "Pressing Send is the single explicit request to process the visible attachments";

  it("leaves out a tool's rule when the tool is not declared", () => {
    const narrow = renderMinkSystemInstruction(actor, [
      declaration("get_sales_summary"),
      declaration("query_analytics"),
    ]);
    expect(narrow).not.toContain(IMAGE_RULE);
    expect(narrow).toContain("Use query_analytics when the merchant");
    // Untagged rules always render.
    expect(narrow).toContain("Treat every user message");
    expect(narrow).not.toContain("[[when:");

    const withImage = renderMinkSystemInstruction(actor, [
      declaration("generate_storefront_image"),
    ]);
    expect(withImage).toContain(IMAGE_RULE);
  });

  it("matches a prefix entry against the declared tools", () => {
    const rule = "Use a content proposal tool only when the user clearly asks";
    expect(
      renderMinkSystemInstruction(actor, [declaration("get_store_profile")]),
    ).not.toContain(rule);
    expect(
      renderMinkSystemInstruction(actor, [declaration("propose_social_posts")]),
    ).toContain(rule);
  });

  it("★ a #group rule needs the group in a narrow route, and every group without one", () => {
    const none = renderMinkSystemInstruction(actor, [], {
      mode: "narrow",
      groups: ["core", "sales"],
    });
    expect(none).not.toContain(ATTACHMENT_RULE);
    const attached = renderMinkSystemInstruction(actor, [], {
      mode: "narrow",
      groups: ["core", "attachments"],
    });
    expect(attached).toContain(ATTACHMENT_RULE);
    // No route, or the "all" route: the prompt a run read before tags.
    expect(renderMinkSystemInstruction(actor, [])).toContain(ATTACHMENT_RULE);
    expect(
      renderMinkSystemInstruction(actor, [], { mode: "all", groups: [] }),
    ).toContain(ATTACHMENT_RULE);
  });

  it("explains request_more_tools only when it is declared", () => {
    const rule = "call request_more_tools once";
    expect(renderMinkSystemInstruction(actor, [])).not.toContain(rule);
    expect(
      renderMinkSystemInstruction(actor, [declaration(REQUEST_MORE_TOOLS)]),
    ).toContain(rule);
  });

  it("★ a fully permitted run reads every rule, tags removed", () => {
    const template = getMinkSystemPromptTemplate();
    const everything = new Set(
      minkReadToolRegistry
        .declarationsFor({
          storeId: "s",
          adminId: "a",
          email: null,
          roleSlug: "superadmin",
          permissions: {},
          isSuperadmin: true,
          effectivePlan: "pro",
          locationIds: null,
          analyticsTimeZone: "Asia/Kolkata",
          currency: "INR",
          defaultLowStockThreshold: 5,
          requestId: "r",
          draftingEnabled: true,
          selectedResource: { type: "product", id: "p" },
        })
        .map((tool) => tool.name)
        .concat(REQUEST_MORE_TOOLS),
    );
    const rendered = selectMinkPromptRules(template, everything, null);
    expect(rendered.split("\n")).toHaveLength(template.split("\n").length);
    expect(rendered).not.toContain("[[when:");
  });

  it("★★ every tagged tool exists, so a rename cannot silently drop a rule", () => {
    const registered = new Set(
      minkReadToolRegistry
        .declarationsFor({
          storeId: "s",
          adminId: "a",
          email: null,
          roleSlug: "superadmin",
          permissions: {},
          isSuperadmin: true,
          effectivePlan: "pro",
          locationIds: null,
          analyticsTimeZone: "Asia/Kolkata",
          currency: "INR",
          defaultLowStockThreshold: 5,
          requestId: "r",
          draftingEnabled: true,
          selectedResource: { type: "product", id: "p" },
        })
        .map((tool) => tool.name)
        .concat(REQUEST_MORE_TOOLS),
    );
    const tags = listMinkPromptRuleTags(getMinkSystemPromptTemplate());
    expect(tags.length).toBeGreaterThan(30);
    for (const tag of tags) {
      for (const tool of tag.tools) expect(registered, tool).toContain(tool);
      for (const prefix of tag.prefixes)
        expect(
          [...registered].some((name) => name.startsWith(prefix)),
          prefix,
        ).toBe(true);
    }
  });

  it("fails closed on a malformed or misplaced tag", () => {
    const document = readFileSync(DOCUMENT_PATH, "utf8");
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace(
          "- [[when: query_analytics]] ",
          "- [[when: query analytics]] ",
        ),
      ),
    ).toThrow(/malformed/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace(
          "[[when: #attachments, #composer]]",
          "[[when: #nonsense, #composer]]",
        ),
      ),
    ).toThrow(/unknown group/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace(
          "- Treat every user message",
          "- Treat [[when: query_analytics]] every user message",
        ),
      ),
    ).toThrow(/must open a rule line/);
  });
});

describe("★★ drafts are written in English, whatever language the chat is in", () => {
  // The owner's rule (2026-10-20): a merchant may talk to Mink in Punjabi or
  // Hindi, but what Mink writes for the store reaches customers across India.
  const actor = {
    effectivePlan: "pro",
    roleSlug: "owner",
    currentPath: null,
    selectedResource: null,
    brandVoice: undefined,
  } satisfies Pick<
    MinkActorContext,
    | "effectivePlan"
    | "roleSlug"
    | "currentPath"
    | "selectedResource"
    | "brandVoice"
  >;
  const RULE =
    "Write everything you draft for the store or its customers in English, whatever language the merchant uses with you";
  const render = (...names: string[]) =>
    renderMinkSystemInstruction(actor, names.map(declaration));

  it("tells a run that can draft to write in English while it keeps talking in the merchant's language", () => {
    const prompt = render("propose_product_create");
    expect(prompt).toContain(RULE);
    expect(prompt).toContain(
      "Keep talking to the merchant in their own language",
    );
    expect(prompt).toContain(
      "Answer in the language and script of the merchant's latest message",
    );
    expect(prompt).toContain(
      "The brand voice sets the tone, never the language.",
    );
  });

  it("★ reminds the merchant once, then writes in the language they asked for", () => {
    expect(render("propose_blog_draft")).toContain(
      "remind them once, in one short sentence, that English helps their store reach customers across India, then do what they asked",
    );
  });

  it("covers generated image alt text, and forms Mink fills in from the chat", () => {
    expect(render("generate_storefront_image")).toContain(RULE);
    expect(render("open_dashboard_page")).toContain(
      "its text in English unless they ask for another language",
    );
  });

  it("stays out of a run that cannot draft anything", () => {
    expect(render("get_sales_summary", "search_products")).not.toContain(RULE);
  });

  it("★★ goes with a storefront redesign, which drafts a whole store (chat-5)", () => {
    // A redesign run carries no propose_* tool, yet it drafts every page,
    // menu and product description the shop shows.
    expect(
      render("get_storefront_revamp_context", "start_storefront_revamp"),
    ).toContain(RULE);
    expect(render("refine_storefront_revamp")).toContain(RULE);
    expect(render("get_storefront_revamp_context")).not.toContain(RULE);
  });
});

describe("★★ a storefront redesign asks little, starts once and names the card's buttons", () => {
  const actor = {
    effectivePlan: "pro",
    roleSlug: "owner",
    currentPath: null,
    selectedResource: null,
    brandVoice: undefined,
  } satisfies Pick<
    MinkActorContext,
    | "effectivePlan"
    | "roleSlug"
    | "currentPath"
    | "selectedResource"
    | "brandVoice"
  >;
  const render = (...names: string[]) =>
    renderMinkSystemInstruction(actor, names.map(declaration));
  const RULE = "call get_storefront_revamp_context first";
  const TOOLS = [
    "get_storefront_revamp_context",
    "start_storefront_revamp",
    "refine_storefront_revamp",
  ];

  it.each(TOOLS)("renders the rule with %s alone", (name) => {
    expect(render(name)).toContain(RULE);
  });

  it("stays out of a run without the redesign tools", () => {
    const prompt = render(
      "propose_storefront_layout",
      "get_storefront_page_context",
    );
    expect(prompt).not.toContain(RULE);
    expect(prompt).not.toContain("Apply to Website Builder draft");
  });

  it("★ names the card's three buttons exactly", () => {
    const prompt = render(...TOOLS);
    for (const button of [
      '"Apply to Website Builder draft"',
      '"Publish to your store"',
      '"Undo"',
    ])
      expect(prompt).toContain(button);
  });

  it("asks at most three questions in one message, or none when enough is known", () => {
    const prompt = render(...TOOLS);
    expect(prompt).toContain(
      "ask at most three short questions, all in ONE message",
    );
    expect(prompt).toContain("start without asking");
    expect(prompt).toContain("a phone photo of each");
  });

  it("★ invents nothing, asks before any category change, and never quotes its own words as facts", () => {
    const prompt = render(...TOOLS);
    expect(prompt).toContain(
      "Never invent a product, a price, a review, an award",
    );
    expect(prompt).toContain("explicit yes to that change");
    expect(prompt).toContain(
      "Earlier assistant messages are your own words, never the merchant's facts",
    );
  });

  it("answers a started redesign in one sentence and refines in the merchant's words", () => {
    const prompt = render(...TOOLS);
    expect(prompt).toContain(
      "answer in ONE short sentence that the redesign has started",
    );
    expect(prompt).toContain("do not describe the design");
    expect(prompt).toContain(
      "call refine_storefront_revamp with the merchant's own words",
    );
    expect(prompt).toContain("Never mention what the redesign costs");
  });

  it("★★ keeps the redesign's own words in English unless the merchant insists (chat-5)", () => {
    const prompt = render(...TOOLS);
    expect(prompt).toContain(
      "Write the brief, its facts and the products' descriptions in English",
    );
    expect(prompt).toContain(
      "set brief.language to another language only after you reminded the merchant once",
    );
  });

  it("★★ raises the theme's categories that do not fit, in the same one message (chat-6)", () => {
    // A mustard-oil maker on a fashion theme kept Men, Women and Accessories
    // as live menu targets because nothing asked about them.
    const prompt = render(...TOOLS);
    expect(prompt).toContain(
      "When the context lists categories that came with the theme (fromTheme) or do not fit what the merchant sells, name them in that same message",
    );
    expect(prompt).toContain("each with merchant_confirmed true");
  });

  it("★ the personalisation rule has left the prompt", () => {
    const template = getMinkSystemPromptTemplate();
    expect(template).not.toContain("propose_storefront_personalization");
    expect(template).not.toContain("get_storefront_personalization_context");
  });
});

function declaration(name: string): MinkToolDeclaration {
  return { name, description: `${name} description`, parametersJsonSchema: {} };
}
