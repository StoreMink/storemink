// ---------------------------------------------------------------------------
// Which tools a Mink run starts with.
//
// ★★ EVERY MODEL STEP RE-SENDS THE SYSTEM PROMPT AND EVERY DECLARED TOOL, and
// for an owner that was ~25,000 tokens a step: a 55,000-character prompt plus
// 73,000 characters of 58 tool declarations, measured on the local ledger
// (2026-10-19). "How much did I sell today?" paid for the Website Builder, the
// image generator and six background workflows on every step. This module
// picks the groups a message needs from its wording, the page it was sent
// from and the conversation it continues, so a help question carries the Help
// search tool and not the Website Builder.
//
// ★ IT ONLY EVER NARROWS WHAT THE REGISTRY ALREADY PERMITS. The permission
//   filter (`MinkToolRegistry.declarationsFor`) runs first and stays the
//   boundary; a route can drop a permitted tool, never add one.
//
// ★ "ALL" IS THE FALLBACK, NOT AN ERROR. A message with no topical word ("do
//   it", "what can you do?", a pasted paragraph) keeps every permitted tool,
//   exactly as before routing existed. Narrowing is for messages that say what
//   they are about.
//
// ★★ A MISS IS RECOVERABLE. A narrowed run also declares `request_more_tools`;
//   when the model finds it needs a capability it was not given, it calls that
//   and the orchestrator restarts the request with every permitted tool on the
//   main model (orchestrator.ts). So the cost of a wrong guess is one cheap
//   abandoned turn, never a refusal the merchant can see.
//
// PURE: no server imports, so the tests and the budget test can run it over
// the eval corpus without a database.
// ---------------------------------------------------------------------------

import { MINK_CSV_MARKER } from "./csv-input";
import { REVIEWED_DOCUMENT_MARKER } from "./document-input";
import { SAVED_MEDIA_MARKER } from "./media-attachment";
import type { MinkSelectedResource, MinkToolDeclaration } from "./types";

export const MINK_TOOL_GROUPS = [
  "core",
  "help",
  "navigation",
  "store",
  "catalog",
  "categories",
  "inventory",
  "sales",
  "orders",
  "offers",
  "marketing",
  "customers",
  "shipping",
  "blogs",
  "builder",
  "revamp",
  "storefront_code",
  "media",
  "csv",
  "brief",
  "watches",
  "weekly_report",
  "revenue_investigation",
  "launch",
  "slow_inventory",
  "pickup_review",
  "attachments",
  "composer",
] as const;
export type MinkToolGroup = (typeof MINK_TOOL_GROUPS)[number];

interface GroupTools {
  /** Sent whenever the group is routed. */
  read: readonly string[];
  /** Sent only when the message asks for a change (`wantsChange`). */
  change?: readonly string[];
  /**
   * Sent only when the route names them in `stateTools`: the conversation's
   * state decides these, not the wording of one message.
   */
  stateful?: readonly string[];
}

const REVAMP_CONTEXT = "get_storefront_revamp_context";
const REVAMP_START = "start_storefront_revamp";
const REVAMP_REFINE = "refine_storefront_revamp";

/**
 * ★ A tool may sit in several groups; the route is the union. A tool in NO
 * group is reachable only through the "all" fallback or a restart, which
 * `tool-routing.test.ts` refuses for every registered tool, so a tool added
 * later has to be given a home here.
 */
export const MINK_TOOL_GROUP_TOOLS: Record<MinkToolGroup, GroupTools> = {
  core: { read: ["get_store_profile", "search_help_centre"] },
  help: { read: ["search_help_centre", "open_dashboard_page"] },
  navigation: { read: ["open_dashboard_page"] },
  store: { read: ["get_store_profile"] },
  catalog: {
    read: [
      "get_catalog_summary",
      "search_products",
      "get_current_product",
      "search_storefront_categories",
    ],
    change: [
      "propose_product_create",
      "propose_current_product_description",
      "propose_current_product_seo",
      "propose_product_images",
      "get_products_for_bulk_price_update",
      "propose_bulk_price_update",
      "list_storefront_media",
    ],
  },
  categories: {
    read: ["search_storefront_categories"],
    change: [
      "get_category_for_draft",
      "propose_category_create",
      "propose_category_update",
      "list_storefront_media",
    ],
  },
  inventory: {
    read: ["list_low_stock", "get_catalog_summary", "search_products"],
    change: [
      "get_inventory_item_for_adjustment",
      "propose_inventory_adjustment",
      "get_inventory_items_for_bulk_adjustment",
      "propose_bulk_inventory_adjustment",
    ],
  },
  sales: { read: ["get_sales_summary", "query_analytics"] },
  orders: {
    read: ["list_orders", "get_current_order"],
    change: [
      "get_order_for_status_transition",
      "propose_order_status_transition",
    ],
  },
  offers: {
    read: ["list_current_offers"],
    change: [
      "get_coupon_for_draft",
      "propose_coupon_create",
      "propose_coupon_update",
    ],
  },
  marketing: {
    read: ["get_marketing_channels", "list_current_offers"],
    change: [
      "get_coupon_for_draft",
      "propose_coupon_email",
      "propose_social_posts",
      "propose_customer_message",
    ],
  },
  customers: {
    read: ["get_customer_group_for_draft"],
    change: [
      "propose_customer_group_create",
      "propose_customer_group_update",
      "propose_customer_message",
    ],
  },
  shipping: { read: ["get_shipping_settings"] },
  blogs: {
    read: ["list_blogs"],
    // A new blog comes with a generated cover by default (system prompt), so
    // drafting one needs the image tool and the reads that ground it.
    change: [
      "propose_blog_draft",
      "list_storefront_media",
      "generate_storefront_image",
      "search_products",
      "search_storefront_categories",
    ],
  },
  builder: {
    read: [
      "list_storefront_pages",
      "get_storefront_page_context",
      "get_storefront_section_context",
      "get_storefront_design_context",
      "get_website_builder_context",
      "list_storefront_media",
    ],
    change: [
      "propose_website_builder_change",
      "propose_storefront_layout",
      "propose_storefront_design",
      "search_products",
      "search_storefront_categories",
      "list_current_offers",
    ],
  },
  // ★ THE CONVERSATION, NOT THE MESSAGE, PICKS THE REVAMP TOOL. A redesign
  //   is an interview, and the message that finishes it is the merchant's
  //   answers ("we sell handmade candles in Pune, warm and calm"), which
  //   carries no change word, so the start rides with the interview window
  //   as well as with a change request. Once the conversation holds a
  //   finished redesign only the refinement is sent: a second start would
  //   throw away the review the merchant is looking at.
  revamp: {
    read: [REVAMP_CONTEXT],
    stateful: [REVAMP_START, REVAMP_REFINE],
  },
  // ★ The code proposal is sent even for a question, because "explain how a
  //   custom-code proposal is reviewed" is answered from that tool's rules.
  storefront_code: {
    read: [
      "get_storefront_page_context",
      "get_storefront_section_context",
      "get_storefront_design_context",
      "propose_storefront_custom_code",
    ],
  },
  media: {
    read: ["list_storefront_media"],
    change: [
      "generate_storefront_image",
      "search_products",
      "search_storefront_categories",
      "propose_product_images",
    ],
  },
  csv: { read: ["inspect_product_csv", "correct_product_csv"] },
  brief: { read: ["start_business_brief", "get_mink_watches"] },
  watches: { read: ["get_mink_watches", "get_mink_watch_responses"] },
  weekly_report: {
    read: ["start_weekly_trading_report", "get_sales_summary"],
  },
  revenue_investigation: {
    read: ["start_revenue_decline_investigation", "get_sales_summary"],
  },
  launch: { read: ["start_product_launch_preparation", "search_products"] },
  slow_inventory: {
    read: ["start_slow_inventory_promotion", "list_low_stock"],
  },
  pickup_review: { read: ["start_delayed_pickup_review", "list_orders"] },
  // Tool-less: these only switch on the prompt rules tagged for them.
  attachments: { read: [] },
  composer: { read: [] },
};

/** Groups a lite model may answer: reads with one obvious tool path. */
const LIGHT_GROUPS: ReadonlySet<MinkToolGroup> = new Set([
  "core",
  "help",
  "navigation",
  "store",
  "catalog",
  "categories",
  "inventory",
  "sales",
  "orders",
  "offers",
  "marketing",
  "customers",
  "shipping",
  "blogs",
  "media",
  "watches",
]);

/** Groups that carry no tool; on their own they cannot narrow a run. */
const TOOL_LESS_GROUPS: ReadonlySet<MinkToolGroup> = new Set([
  "attachments",
  "composer",
]);

// ---------------------------------------------------------------------------
// Vocabulary
//
// English patterns use word boundaries over lower-cased text; the Hinglish and
// Devanagari lists are plain substrings, because JavaScript's `\b` knows only
// ASCII word characters. Over-matching costs a few hundred tokens; a miss costs
// a restart, so the lists lean wide.
// ---------------------------------------------------------------------------

interface Vocabulary {
  words?: RegExp;
  phrases?: readonly string[];
  /**
   * Pairs of phrase lists that count only together: a phrase of each list
   * somewhere in the message. ★ For a phrase too common to stand alone
   * ("hisaab se" is "by" or "according to" in Hinglish) that means a
   * redesign only beside a whole-store object.
   */
  together?: ReadonlyArray<readonly [readonly string[], readonly string[]]>;
}

function words(source: string): RegExp {
  return new RegExp(`\\b(?:${source})\\b`, "i");
}

const TOPICS: Partial<Record<MinkToolGroup, Vocabulary>> = {
  store: {
    words: words(
      "plans?|subscription|subscribed|my store|store name|store's name|store status|store url|store link|store address|slug|store active|is (?:my|the) store",
    ),
  },
  help: {
    words: words(
      "how (?:do|can|should|would) (?:i|we)|how does .{0,40} work|how's (?:it|this) work|where (?:do|can|should|would) (?:i|we)|where (?:is|are) (?:the|my) .{0,40}(?:button|page|setting|settings|option|options|menu|tab)|where's the|walk me through|guide me|tutorial|teach me|help me (?:understand|find|with)|show me (?:how|where)|what does .{0,40} mean|troubleshoot\\w*|not working|doesn't work|isn't working|can't (?:find|see|get)|cannot (?:find|see|get)|unable to|set ?up|configure|connect",
    ),
    phrases: [
      "kaise",
      "kahan",
      "kahaan",
      "kidhar",
      "samjhao",
      "madad",
      "कैसे",
      "कहाँ",
      "कहां",
      "किधर",
      "मदद",
      "समझाओ",
    ],
  },
  navigation: {
    words: words(
      "open|go to|take me|navigate|bring up|jump to|link to|highlight|point (?:me )?to|show me the \\w+ (?:page|screen|settings?)",
    ),
    phrases: ["kholo", "khol do", "le chalo", "खोलो", "खोल दो"],
  },
  catalog: {
    words: words(
      "products?|catalog(?:ue)?|items?|sku\\w*|listings?|prices?|pricing|mrp|descriptions?|seo|meta (?:title|description)|variants?|barcodes?|archived|unpublished|published",
    ),
    phrases: [
      "saman",
      "samaan",
      "keemat",
      "kimat",
      "daam",
      "उत्पाद",
      "प्रोडक्ट",
      "सामान",
      "कीमत",
      "दाम",
    ],
  },
  categories: {
    words: words("categor(?:y|ies)|collections?|departments?|aisles?"),
    phrases: ["श्रेणी", "कैटेगरी"],
  },
  inventory: {
    words: words(
      "stocks?|inventory|out of stock|out-of-stock|in stock|running (?:out|low)|run out|low|lowest|restock\\w*|reorder\\w*|units? (?:left|available)|quantity|quantities|qty|warehouses?|shel(?:f|ves)|thresholds?|tracked|sellable",
    ),
    phrases: ["khatam", "स्टॉक", "खत्म"],
  },
  sales: {
    words: words(
      "sales?|sold|sell|selling|revenue|turnover|income|earn\\w*|takings|aov|average order|order value|net|gross|profits?|margins?|today|today's|yesterday|yesterday's|this (?:week|month|year)|last (?:week|month|year|\\d+ days?)|past (?:week|month|\\d+ days?)|month[- ]to[- ]date|year[- ]to[- ]date|mtd|ytd|units|trends?|charts?|graphs?|reports?|analytics|compare|comparison|versus|vs|growth|performance|conversion|traffic|visitors?|sessions?|best[- ]?sellers?|top (?:products|sellers|selling)",
    ),
    phrases: [
      "bikri",
      "bikree",
      "becha",
      "beche",
      "kamai",
      "munafa",
      "aaj",
      "bikne",
      "bikta",
      "bikti",
      "बिक",
      "बेचा",
      "बेचे",
      "कमाई",
      "मुनाफ़ा",
      "मुनाफा",
      "आज",
    ],
  },
  orders: {
    words: words(
      "orders?|ord\\d\\w*|pending|unfulfilled|fulfil\\w*|fulfill\\w*|shipped|shipments?|dispatch\\w*|delivered|undelivered|cod|cash on delivery|refunds?|refunded|returns?|returned|cancel\\w*|courier|awb|tracking|purchases?|checkout",
    ),
    phrases: ["aarder", "ऑर्डर", "आर्डर"],
  },
  offers: {
    words: words(
      "offers?|coupons?|discounts?|promo\\w*|deals?|bogo|buy (?:one|1|2|two) get|cash ?back|sale|percent off|percentage off|free (?:gift|item)",
    ),
    phrases: ["chhoot", "chhut", "छूट", "ऑफ़र", "ऑफर", "कूपन", "डिस्काउंट"],
  },
  marketing: {
    words: words(
      "marketing|campaigns?|newsletters?|subscribers?|emails?|social(?: media)?|instagram|insta|facebook|whatsapp|captions?|hashtags?|ads?|advert\\w*|promote|audience|ga4|google analytics|meta pixel|pixel|channels?",
    ),
    phrases: ["prachar", "प्रचार", "मार्केटिंग"],
  },
  customers: {
    words: words(
      "customers?|shoppers?|buyers?|clients?|groups?|segments?|vip|loyal\\w*",
    ),
    phrases: ["grahak", "ग्राहक"],
  },
  shipping: {
    words: words(
      "shipping|ship|delivery|deliveries|deliver|shiprocket|pin ?codes?|postcodes?|weights?|parcels?|pickup locations?",
    ),
    phrases: ["डिलीवरी"],
  },
  blogs: {
    words: words("blogs?|blog posts?|articles?|posts?|write-?ups?"),
    phrases: ["lekh", "ब्लॉग", "लेख"],
  },
  builder: {
    words: words(
      "website|web site|my site|storefront|store front|online store|shop front|homepage|home page|landing page|about (?:us )?page|contact page|faq page|policy page|pages|page (?:layout|design|sections?|seo|title)|sections?|header|footer|menus?|navigation|nav|navbar|nav bar|themes?|template|layouts?|hero|banners?|carousel|slider|slideshow|gallery|testimonials?|announcement bar|builder|publish (?:the |my )?(?:site|website|store|storefront|page|homepage|home page|changes|header|footer|menu|draft)|unpublish\\w*|go live|is (?:it|this|my (?:site|store|page)) live|logo|branding|colou?rs?|fonts?|typeface|typography|palette|look and feel|looks? like|design|redesign|appearance|aesthetic|broken links?|menu links?|polic(?:y|ies)",
    ),
    phrases: ["वेबसाइट", "होमपेज"],
  },
  // ★ Whole-store wording only: "customise the header" or "redesign the
  //   homepage" is a Builder edit, "customise my store" is a redesign.
  revamp: {
    words: words(
      "(?:customi[sz]|personali[sz])(?:e|es|ed|ing) (?:my |our |the |this )?(?:whole |entire |online )?(?:store|shop|site|website|storefront|store front)|(?:revamp|redesign|rebuild|overhaul|refresh)(?:s|ed|ing)? (?:my |our |the |this )?(?:whole |entire |online )?(?:store|shop|site|website|storefront|store front)|(?:store|shop|site|website|storefront|dukaan|dukan)(?: ko)? (?:customi[sz]e|personali[sz]e|redesign|revamp|rebuild)|(?:make|build|create|design|set up) (?:me )?(?:a |my |our |the |this )?(?:new )?(?:whole |entire |online )?(?:store|shop|site|website|storefront)(?: look| feel)? (?:for|around|about|to fit|to suit|to match|that fits) (?:my|our) (?:business|brand|products?|shop)|build (?:me )?(?:a |my |our |the )?(?:new )?(?:online )?(?:store|shop|site|website|storefront)|make (?:my |our |the |this )?(?:store|shop|site|website|storefront) (?:look |feel )?(?:like (?:mine|my own|my brand|my business|my shop)|mine|my own|more (?:me|personal|unique)|personal|unique)|(?:generic|default|sample) (?:theme|photos?|pictures?|images?|banners?|content|text)|theme(?:'s)? (?:photos?|pictures?|images?|banners?|sample (?:text|content))|replace (?:all )?(?:the )?(?:theme(?:'s)? )?(?:photos?|pictures?|images?|banners?) (?:with|for) (?:my|our)|(?:fit|suit|match) (?:my|our) (?:business|brand|products?|shop|store)|rebrand(?:ing)?|tailor(?:ed)? (?:to|for) (?:my|our)|personali[sz]ations? (?:of|for) (?:my |our |the |this )?(?:whole |entire |online )?(?:store|shop|site|website|storefront|store front)",
    ),
    phrases: [
      "personalise karo",
      "personalize karo",
      "customise karo",
      "customize karo",
      "website bana",
      "site bana",
      "store bana",
      "dukaan bana",
      "nayi website",
      "पर्सनलाइज",
      "पर्सनलाइज़",
      "कस्टमाइज",
      "कस्टमाइज़",
      "रीडिज़ाइन",
      "रीडिजाइन",
      "वेबसाइट बना",
      "स्टोर बना",
    ],
    // ★★ "hisaab se" ALONE IS ORDINARY HINGLISH ("city ke hisaab se orders
    //   dikhao", orders by city), and it opened the redesign interview, so the
    //   start tool and its rule rode on the next three unrelated turns. It is
    //   a redesign only as "business ke hisaab se" beside a whole-store object
    //   (chat-7).
    together: [
      [
        [
          "business ke hisaab se",
          "business ke hisab se",
          "brand ke hisaab se",
          "brand ke hisab se",
          "dhande ke hisaab se",
          "dhande ke hisab se",
          "kaam ke hisaab se",
          "kaam ke hisab se",
        ],
        ["website", "web site", "site", "store", "shop", "dukaan", "dukan"],
      ],
      [
        [
          "बिज़नेस के हिसाब से",
          "बिजनेस के हिसाब से",
          "ब्रांड के हिसाब से",
          "धंधे के हिसाब से",
          "काम के हिसाब से",
        ],
        ["वेबसाइट", "स्टोर", "दुकान", "साइट", "शॉप"],
      ],
    ],
  },
  storefront_code: {
    words: words(
      "custom[- ]code|code (?:section|proposal)|html|css|javascript|js|scripts?|sandbox\\w*|embed\\w*|widgets?|iframe|snippets?|source code",
    ),
  },
  media: {
    words: words(
      "images?|pictures?|photos?|photograph\\w*|pics?|artwork|visuals?|graphics?|illustrations?|media(?: library)?|thumbnails?|cover|banners?|hero",
    ),
    phrases: ["tasveer", "tasvir", "फोटो", "फ़ोटो", "तस्वीर", "चित्र", "इमेज"],
  },
  csv: {
    words: words(
      "csv|spreadsheet|excel|xlsx|import\\w*|bulk upload|upload (?:a |my )?file",
    ),
  },
  brief: {
    words: words(
      "brief|briefing|overview|needs? (?:my )?attention|what should i (?:focus on|look at)|health check|how(?:'s| is) (?:my |the )?(?:business|store|shop)(?: doing| going)?|summary of (?:my |the )?(?:business|store|day|week)|summari[sz]e (?:my |the )?(?:business|store|shop|day|week)|business summary|daily (?:summary|update|report)|morning report",
    ),
  },
  watches: {
    words: words(
      "watch(?:es)?|alerts?|monitor\\w*|notify me|let me know when|keep an eye|recurring|every (?:day|week|morning|monday)|suggested responses?",
    ),
  },
  weekly_report: {
    words: words("weekly (?:trading )?report|trading report"),
  },
  revenue_investigation: {
    words: words(
      "investigat\\w*|diagnos\\w*|root cause|why (?:did|has|have|is|are) .{0,40}(?:revenue|sales|income|orders?)",
    ),
  },
  launch: {
    words: words("launch\\w*|ready to sell|readiness|go-to-market"),
  },
  slow_inventory: {
    words: words(
      "slow[- ]moving|slow (?:inventory|stock|sellers?|movers?|items?|products?)|dead stock|not selling|(?:haven't|have not|hasn't|has not|didn't|did not) sold|(?:haven't|have not|hasn't|has not) been sold|not sold|unsold|no sales|ag(?:e)?ing stock|clearance|overstock\\w*",
    ),
  },
  pickup_review: {
    words: words("pick-?ups?|uncollected|click and collect|store collection"),
  },
  composer: {
    words: words(
      "attach\\w*|mic|microphone|dictat\\w*|voice (?:chat|note|message)|speak|talk (?:to|with) (?:you|mink)|screenshots?|drag and drop|plus button|sound-?wave",
    ),
  },
};

/** A revenue question becomes an investigation only alongside a fall word. */
const REVENUE_WORDS = words("revenue|sales|income|turnover");
const DECLINE_WORDS = words(
  "declin\\w*|drop\\w*|fell|fall\\w*|dip\\w*|decreas\\w*|slump\\w*|down",
);

const CHANGE_WORDS = words(
  "add|create|make|build|rebuild|redo|generate|draft|write|rewrite|compose|prepare|propose|update|change|edit|modify|set|fix|correct|improve|enhance|optimi[sz]e|customi[sz](?:e|ed|ing)|personali[sz](?:e|ed|ing)|rebrand|replace|remove|delete|hide|unhide|publish|unpublish|schedule|send|launch|adjust|increase|decrease|reduce|raise|lower|mark|move|rename|reorder|rearrange|redesign|restyle|upload|import|apply|activate|deactivate|enable|disable|turn (?:on|off)|switch|put|place|insert|swap|convert|translate|shorten|lengthen|refresh|revamp|tweak|restock|transfer|refund|cancel|duplicate|copy|clone|use (?:this|that|these|those|it|my|the)|(?:need|want|would like|looking for) (?:a |an |some |the )?(?:new )?(?:picture|image|photo|banner|hero|page|section|description|blog|post|caption|coupon|offer|discount|product|category|group|menu|logo|design|layout|campaign|email|message)",
);
const CHANGE_PHRASES = [
  " banao",
  "bana do",
  "banado",
  "bana de",
  "badlo",
  "badal do",
  "badal de",
  "likho",
  "likh do",
  "likh de",
  "hatao",
  "hata do",
  "daalo",
  "daal do",
  "dal do",
  "bhejo",
  "bhej do",
  "jodo",
  "jod do",
  " karo",
  "kar do",
  "kardo",
  "kar de",
  "sudharo",
  "lagao",
  "laga do",
  "बनाओ",
  "बना दो",
  "बनाइए",
  "बदलो",
  "बदल दो",
  "लिखो",
  "लिख दो",
  "हटाओ",
  "हटा दो",
  "डालो",
  "भेजो",
  "जोड़ो",
  "जोड़ दो",
  "करो",
  "कर दो",
  "कीजिए",
  "लगाओ",
];

/**
 * "How do I add a product?" asks HOW, so it gets the read tools and the Help
 * search, not the proposal tools - unless it also asks ("...can you add one
 * called Tea?").
 */
const HOW_TO = words(
  "how (?:do|can|should|would) (?:i|we)|where (?:do|can|should) (?:i|we)|(?:show|teach|tell) me how|explain how|kaise",
);
/**
 * A question that OPENS with "how to" or "where is" is a how-to; the same
 * words inside a request ("write a post about how to care for leather") are
 * its subject, not its form.
 */
const QUESTION_START =
  /^(?:(?:hi|hey|hello|please|ok|okay)[,!. ]+)?(?:how to|how do (?:i|we)|how can (?:i|we)|where (?:is|are|do|can)|is it possible|what(?:'s| is) the difference)\b/i;
const HOW_TO_PHRASES = ["कैसे"];
const EXPLICIT_REQUEST = words(
  "please|for me|can you|could you|would you|will you|go ahead|do it",
);

const COURTESY =
  "hi+|hello|hey|hlo|yo|thanks|thank you|thank u|thx|ty|ok(?:ay)?|great|cool|nice|awesome|perfect|got it|noted|alright|that's all|that's it|that is all|all good|good (?:morning|afternoon|evening|night)|bye|goodbye|see you|namaste|namaskar|shukriya|dhanyavaa?d|dhanyawaa?d|नमस्ते|धन्यवाद|शुक्रिया";
/**
 * Greetings and thanks, alone or strung together ("thanks, that's all").
 * ⚠ A bare "ok" is a go-ahead, not smalltalk (CONFIRMATION); only "ok"
 * joined to another courtesy counts here.
 */
const SMALLTALK = new RegExp(
  `^(?:${COURTESY})(?:[\\s!.,🙏😊👍]+(?:${COURTESY}))*[\\s!.,🙏😊👍]*$`,
  "iu",
);
const BARE_OK = /^(?:ok(?:ay)?|okk)[\s!.]*$/i;

/**
 * A short go-ahead ("yes", "do it", "kar do") authorises the change the
 * conversation was already about.
 */
const CONFIRMATION =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|okk|haan|han|ha|ji|ji haan|go ahead|do it|please do(?: it)?|please go ahead|please proceed|proceed|continue|carry on|confirm(?:ed)?|correct|that's right|sounds good|perfect|kar do|kardo|karo|theek hai|thik hai|हाँ|हां|जी|ठीक है|कर दो)(?=$|[\s!.,])/iu;
const CONFIRMATION_MAX_WORDS = 8;

/**
 * Words that point at the page, the selected record or the last turn.
 * ⚠ Not "that": as a relative pronoun ("items that are low") it is in half of
 * all questions and would widen every route on every page.
 */
const DEICTIC = words(
  "this|these|those|it|its|here|same|current|selected|on (?:this|the) (?:page|screen)",
);
const DEICTIC_PHRASES = [
  "yeh",
  " ye ",
  "isko",
  "iska",
  "iske",
  "isse",
  "wahi",
  "wohi",
  "usko",
  "uska",
  "यह",
  "ये",
  "इस",
  "इसे",
  "इसको",
  "इसका",
  "वही",
  "उसे",
  "उसका",
];
/** A message that carries on from the last one ("and for Delhi?", "now the about page"). */
const CONTINUATION =
  /^(?:and|also|plus|but|what about|how about|now|then|instead|again|same|actually|aur|ab|phir|और|अब|फिर)\b|\b(?:again|instead|as well|the same)\b/iu;

/** Phrasing that probes the boundary keeps a run on the main model. */
const SENSITIVE = words(
  "ignore (?:all |every |previous |prior |your |the )*(?:instructions?|rules?)|system prompt|pretend|jailbreak|developer mode|superadmin|super admin|permission map|permissions|store ?id|admin ?id|api keys?|secrets?|cookies?|passwords?|tokens?|credentials?|sql|select \\*|drop table|dump\\w*|database|bypass|override",
);

/** Dashboard areas, longest prefix first. */
const PAGE_GROUPS: ReadonlyArray<readonly [string, MinkToolGroup]> = [
  ["/dashboard/settings/shipping", "shipping"],
  ["/dashboard/marketing/coupons", "offers"],
  ["/dashboard/products", "catalog"],
  ["/dashboard/inventory", "inventory"],
  ["/dashboard/orders", "orders"],
  ["/dashboard/analytics", "sales"],
  ["/dashboard/offers", "offers"],
  ["/dashboard/marketing", "marketing"],
  ["/dashboard/categories", "categories"],
  ["/dashboard/blogs", "blogs"],
  ["/dashboard/builder", "builder"],
  ["/dashboard/storefront", "builder"],
  ["/dashboard/navigation", "builder"],
  ["/dashboard/branding", "builder"],
  ["/dashboard/media", "media"],
  ["/dashboard/users", "customers"],
  ["/dashboard/mink-watches", "watches"],
];

const ATTACHMENT_MARKERS = [
  SAVED_MEDIA_MARKER,
  REVIEWED_DOCUMENT_MARKER,
  MINK_CSV_MARKER,
] as const;

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export interface MinkToolRouteInput {
  message: string;
  currentPath?: string | null;
  selectedResource?: Pick<MinkSelectedResource, "type"> | null;
  /** Earlier turns of this conversation, oldest first; only user turns are read. */
  history?: ReadonlyArray<{ role: string; text: string }>;
  answerMedium?: "written" | "spoken";
  /**
   * The storefront redesigns this conversation holds (the stream route reads
   * them). `hasReady`: one finished and not undone, so it can be refined;
   * `hasActive`: one still building.
   */
  revamp?: { hasReady: boolean; hasActive: boolean };
}

export interface MinkToolRoute {
  /** "all" keeps every permitted tool: the behaviour before routing existed. */
  mode: "all" | "narrow";
  /** The routed groups, `core` always among them when narrow. */
  groups: MinkToolGroup[];
  /** Whether the message asks for something to be created or changed. */
  wantsChange: boolean;
  /** Eligible for the lite model: a narrow, read-only, ordinary question. */
  light: boolean;
  /** Short, content-free labels for the run log ("topic", "page", "history"). */
  reasons: string[];
  /**
   * The `stateful` group tools this route sends (the revamp start or
   * refinement). Absent or empty: none of them.
   */
  stateTools?: string[];
}

export function routeMinkTools(input: MinkToolRouteInput): MinkToolRoute {
  const text = visibleText(input.message);
  const attached = hasAttachment(input.message);
  const reasons: string[] = [];

  // ★★ THE VOCABULARY BELOW READS ENGLISH, HINGLISH AND DEVANAGARI, AND
  // NOTHING ELSE. A message written mostly in another script cannot be
  // judged by it: "draft a new product for my almond shake" in Punjabi
  // matched only its "MRP" and was sent catalogue reads with no way to draft,
  // so the run had to ask for more tools and start again. Such a message
  // keeps every permitted tool, the fallback for a message the router cannot
  // place.
  if (unreadScript(text)) {
    const groups = topicalGroups(text);
    if (attached) groups.add("attachments");
    return {
      mode: "all",
      groups: sortGroups(groups),
      wantsChange: changeRequested(text),
      light: false,
      reasons: ["unread_script"],
    };
  }

  if (SMALLTALK.test(text.trim()) && !BARE_OK.test(text.trim()) && !attached) {
    return {
      mode: "narrow",
      groups: ["core"],
      wantsChange: false,
      light: input.answerMedium !== "spoken",
      reasons: ["smalltalk"],
    };
  }

  const groups = topicalGroups(text);
  if (groups.size) reasons.push("topic");
  const trimmed = text.trim();
  const confirmation =
    CONFIRMATION.test(trimmed) &&
    trimmed.split(/\s+/).length <= CONFIRMATION_MAX_WORDS;
  const deictic = DEICTIC.test(text) || hasPhrase(text, DEICTIC_PHRASES);
  const continuation = confirmation || deictic || CONTINUATION.test(trimmed);
  let wantsChange = changeRequested(text) || confirmation;

  if (attached) groups.add("attachments");

  // A follow-up ("make it shorter", "and for Delhi?", "yes") continues the
  // last thing asked, so it borrows that message's groups and its intent.
  if (continuation) {
    const previous = lastUserMessage(input.history);
    if (previous) {
      const previousText = visibleText(previous);
      const before = groups.size;
      for (const group of topicalGroups(previousText)) groups.add(group);
      if (hasAttachment(previous)) groups.add("attachments");
      if (groups.size > before) reasons.push("history");
      if (changeRequested(previousText)) wantsChange = true;
    }
  }

  // ★ An interview keeps its tools. A redesign is several answers long and
  //   the answers rarely repeat the word that started it, so a recent message
  //   that asked for one keeps the group for the turns after.
  const interview = recentlyAskedToRevamp(input.history);
  if (!groups.has("revamp") && interview) {
    groups.add("revamp");
    reasons.push("interview");
  }

  // ★ A finished redesign is refined in the merchant's own words ("make it
  //   warmer", "redo the opening photo"), which rarely name the store, so
  //   while the conversation holds one, a follow-up or anything about what
  //   shoppers see brings the group along.
  // ★★ ADDING PRODUCTS OR CATEGORIES IS A REFINEMENT TOO (chat-3): "Add my
  //   products" is a chip under every redesign card, and it names only the
  //   catalogue, so once the interview window closed it was sent the
  //   standalone product draft and the redesign got no product section. A
  //   catalogue question that changes nothing stays off it.
  const revampState = input.revamp;
  const catalogueChange =
    wantsChange && (groups.has("catalog") || groups.has("categories"));
  if (
    !groups.has("revamp") &&
    (revampState?.hasReady || revampState?.hasActive) &&
    (continuation ||
      groups.has("builder") ||
      groups.has("media") ||
      catalogueChange)
  ) {
    groups.add("revamp");
    reasons.push("revamp_state");
  }

  // A record open in the dashboard is what most questions asked from it are
  // about ("what's the stock?" on a product), so its reads always come along;
  // the wider page only when the message points at it ("this", "here").
  const before = groups.size;
  if (input.selectedResource?.type === "product") groups.add("catalog");
  if (input.selectedResource?.type === "order") groups.add("orders");
  if (deictic) {
    const page = pageGroup(input.currentPath);
    if (page) groups.add(page);
  }
  if (groups.size > before) reasons.push("page");

  const toolBearing = [...groups].filter(
    (group) => !TOOL_LESS_GROUPS.has(group),
  );
  if (toolBearing.length === 0) {
    return {
      mode: "all",
      groups: sortGroups(groups),
      wantsChange,
      light: false,
      reasons: [...reasons, "fallback"],
    };
  }

  groups.add("core");
  const sorted = sortGroups(groups);
  const light =
    !wantsChange &&
    !groups.has("attachments") &&
    input.answerMedium !== "spoken" &&
    !SENSITIVE.test(text) &&
    sorted.every((group) => LIGHT_GROUPS.has(group));
  const stateTools = groups.has("revamp")
    ? revampStateTools(revampState, wantsChange || interview)
    : [];
  return {
    mode: "narrow",
    groups: sorted,
    wantsChange,
    light,
    reasons,
    ...(stateTools.length ? { stateTools } : {}),
  };
}

/**
 * ★★ ONE REDESIGN AT A TIME, AND NEVER A SECOND START OVER A FINISHED ONE.
 * A ready redesign is refined, because a fresh start would replace the
 * review the merchant is looking at; one still building gets neither (the
 * job refuses a second, and there is nothing finished to refine yet). With
 * neither, the start comes with a change request or inside the interview.
 */
function revampStateTools(
  state: MinkToolRouteInput["revamp"],
  wantsStart: boolean,
): string[] {
  if (state?.hasReady) return [REVAMP_REFINE];
  if (state?.hasActive) return [];
  return wantsStart ? [REVAMP_START] : [];
}

/** The tools a narrow route sends; null for "all". */
export function toolsForRoute(
  route: Pick<MinkToolRoute, "mode" | "groups" | "wantsChange" | "stateTools">,
): ReadonlySet<string> | null {
  if (route.mode === "all") return null;
  const tools = new Set<string>();
  const picked = new Set(route.stateTools ?? []);
  for (const group of route.groups) {
    const def = MINK_TOOL_GROUP_TOOLS[group];
    for (const name of def.read) tools.add(name);
    if (route.wantsChange) for (const name of def.change ?? []) tools.add(name);
    for (const name of def.stateful ?? [])
      if (picked.has(name)) tools.add(name);
  }
  return tools;
}

export const REQUEST_MORE_TOOLS = "request_more_tools";

/**
 * The escape hatch a narrowed run declares. The orchestrator intercepts it;
 * the registry never sees it.
 */
export const REQUEST_MORE_TOOLS_DECLARATION: MinkToolDeclaration = {
  name: REQUEST_MORE_TOOLS,
  description:
    "Call this on its own, before answering, when the merchant's request needs a StoreMink capability that none of your other declared tools provide: for example creating or changing something when you were given only reads, or a store area you have no tool for. The request then restarts with every tool this admin is permitted to use. Do not call it for something no StoreMink tool does (refunds, cancellations, deleting customers, sending messages directly, payment settings, StoreMink's own code) or to get around a permission.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "One short sentence naming the capability you need.",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

export interface MinkRoutedDeclarations {
  /** What the run starts with, `request_more_tools` last when narrowed. */
  declarations: MinkToolDeclaration[];
  /** Whether any permitted tool was left out. */
  narrowed: boolean;
  /** How many permitted tools were left out. */
  omitted: number;
}

/**
 * Apply a route to the permission-filtered declarations, keeping the
 * registry's order (the order the model has always seen its tools in).
 */
export function applyMinkToolRoute(
  permitted: MinkToolDeclaration[],
  route: Pick<
    MinkToolRoute,
    "mode" | "groups" | "wantsChange" | "stateTools"
  > | null,
): MinkRoutedDeclarations {
  const allowed = route ? toolsForRoute(route) : null;
  if (!allowed) return { declarations: permitted, narrowed: false, omitted: 0 };
  const kept = permitted.filter((declaration) => allowed.has(declaration.name));
  const omitted = permitted.length - kept.length;
  if (omitted === 0)
    return { declarations: permitted, narrowed: false, omitted: 0 };
  return {
    declarations: [...kept, REQUEST_MORE_TOOLS_DECLARATION],
    narrowed: true,
    omitted,
  };
}

// ---------------------------------------------------------------------------

/**
 * True when most of the letters are in a script other than Latin or
 * Devanagari: Punjabi in Gurmukhi, Gujarati, Bengali, Odia, Tamil, Telugu,
 * Kannada, Malayalam, Urdu and anything else the vocabulary has no words for.
 */
function unreadScript(text: string): boolean {
  let read = 0;
  let unread = 0;
  for (const letter of text.match(/\p{L}/gu) ?? []) {
    if (/\p{Script=Latin}|\p{Script=Devanagari}/u.test(letter)) read += 1;
    else unread += 1;
  }
  return unread > read;
}

function topicalGroups(text: string): Set<MinkToolGroup> {
  const groups = new Set<MinkToolGroup>();
  for (const group of MINK_TOOL_GROUPS) {
    const vocabulary = TOPICS[group];
    if (vocabulary && matchesVocabulary(vocabulary, text)) groups.add(group);
  }
  // ★ "Redesign my website" names the Website Builder only because a
  //   redesign covers the whole site. Its proposal tools would ride along on
  //   every redesign step for nothing, so the Builder stays only when the
  //   rest of the message asks for something of its own ("... and change the
  //   header").
  if (
    groups.has("revamp") &&
    groups.has("builder") &&
    !matchesVocabulary(TOPICS.builder!, withoutRevampWording(text))
  )
    groups.delete("builder");
  if (REVENUE_WORDS.test(text) && DECLINE_WORDS.test(text))
    groups.add("revenue_investigation");
  if (QUESTION_START.test(text.trim())) groups.add("help");
  // A how-to question may want the control pointed out (open_dashboard_page's
  // highlight), so help always brings navigation along.
  if (groups.has("help")) groups.add("navigation");
  return groups;
}

function matchesVocabulary(vocabulary: Vocabulary, text: string): boolean {
  return Boolean(
    vocabulary.words?.test(text) ||
    hasPhrase(text, vocabulary.phrases ?? []) ||
    (vocabulary.together ?? []).some(
      ([first, second]) => hasPhrase(text, first) && hasPhrase(text, second),
    ),
  );
}

const REVAMP_WORDING = new RegExp(TOPICS.revamp!.words!.source, "gi");

/** The message with its whole-store redesign wording taken out. */
function withoutRevampWording(text: string): string {
  let rest = text.replace(REVAMP_WORDING, " ");
  for (const phrase of TOPICS.revamp!.phrases ?? [])
    rest = rest.split(phrase).join(" ");
  for (const [first, second] of TOPICS.revamp!.together ?? []) {
    if (!hasPhrase(text, first) || !hasPhrase(text, second)) continue;
    for (const phrase of [...first, ...second])
      rest = rest.split(phrase).join(" ");
  }
  return rest;
}

function changeRequested(text: string): boolean {
  const asked = CHANGE_WORDS.test(text) || hasPhrase(text, CHANGE_PHRASES);
  if (!asked) return false;
  const howTo =
    HOW_TO.test(text) ||
    QUESTION_START.test(text.trim()) ||
    hasPhrase(text, HOW_TO_PHRASES);
  return !howTo || EXPLICIT_REQUEST.test(text);
}

function hasPhrase(text: string, phrases: readonly string[]): boolean {
  if (!phrases.length) return false;
  const padded = ` ${text} `;
  return phrases.some((phrase) => padded.includes(phrase));
}

/** The merchant's own words: attachment payloads are data, not wording. */
function visibleText(message: string): string {
  let end = message.length;
  for (const marker of ATTACHMENT_MARKERS) {
    const index = message.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  return message
    .slice(0, end)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
}

function hasAttachment(message: string): boolean {
  return ATTACHMENT_MARKERS.some((marker) => message.includes(marker));
}

function lastUserMessage(
  history: MinkToolRouteInput["history"],
): string | null {
  if (!history) return null;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role === "user") return history[index].text;
  }
  return null;
}

/** How many recent merchant messages keep a redesign interview going. */
const INTERVIEW_TURNS = 3;

function recentlyAskedToRevamp(
  history: MinkToolRouteInput["history"],
): boolean {
  if (!history) return false;
  const vocabulary = TOPICS.revamp!;
  let seen = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role !== "user") continue;
    if (matchesVocabulary(vocabulary, visibleText(history[index].text))) {
      return true;
    }
    seen += 1;
    if (seen >= INTERVIEW_TURNS) return false;
  }
  return false;
}

function pageGroup(path: string | null | undefined): MinkToolGroup | null {
  if (!path) return null;
  for (const [prefix, group] of PAGE_GROUPS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return group;
  }
  return null;
}

function sortGroups(groups: Set<MinkToolGroup>): MinkToolGroup[] {
  return MINK_TOOL_GROUPS.filter((group) => groups.has(group));
}
