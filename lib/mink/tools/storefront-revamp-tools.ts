import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { minkRevamps, minkRuns, stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { loggableError } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { getProductCreateCapacity } from "@/lib/plans/entitlements";
import { isThemePending } from "@/lib/store/launch-state";
import { getMinkConfig } from "../config";
import { MinkToolInputError, MinkToolTimeoutError } from "../errors";
import { imageCreditHeadroom } from "../image-credits";
import { MINK_MAX_RUN_CREDITS } from "../metering";
import {
  revampFixedCreditCeiling,
  revampOpeningBinding,
  revampPageName,
  revampSectionLabel,
} from "../revamp/assemble";
import {
  REVAMP_LIMITS,
  isFinishedRevampVersion,
  isRefinableRevamp,
  isRevampArtifact,
  type RevampArtifact,
  type RevampKind,
  type RevampRequest,
  type RevampSitePlan,
} from "../revamp/contract";
import {
  FREE_HOLDING_STATUSES,
  cancelRevamp,
  countRefinements,
  createRevampJob,
  listConversationRevamps,
  readRevampForActor,
  readRevampJob,
  revampStartLimit,
  type RevampJobRow,
} from "../revamp/jobs";
import {
  keyRefinementProducts,
  readRevampRequest,
  revampChainCarry,
  revampRequestToWire,
} from "../revamp/request";
import { sanitizeShotId } from "../revamp/site-compiler";
import { readRevampContextForActor } from "../revamp/snapshot";
import { kickRevampRunner } from "../revamp/trigger";
import { claimSpendLimits, releaseSpendLimits } from "../spend-limits";
import { selectOwnedStorefrontImageUrls } from "../storefront-media-read";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool, MinkToolContext } from "./registry";

/**
 * Mink's storefront revamp: one background job that redesigns everything
 * shoppers see, started from the chat and refined from it.
 *
 * ★ THE TOOLS ONLY QUEUE. The redesign itself runs in the revamp runner, so a
 *   start answers in a moment and the card polls for progress; nothing here
 *   writes a page, a product or a photo.
 * ★ EVERY REFUSAL IS DECIDED BEFORE THE JOB EXISTS, in the order the merchant
 *   could fix them, so a job that is queued can actually finish.
 * ★ THE MODEL NEVER SEES A CREDIT FIGURE: the budget goes to the job, and the
 *   model gets only whether it started.
 */

const available = (actor: MinkActorContext) => actor.draftingEnabled === true;

const START_INSTRUCTION =
  "Tell the merchant in one short sentence that the redesign has started and the card shows its progress. Do not describe the design.";
const REFINE_INSTRUCTION =
  "Tell the merchant in one short sentence that the changes have started and the card shows their progress. Do not describe the design.";
const RELAY_INSTRUCTION =
  "Tell the merchant this in one short sentence, in plain words.";

const THEME_FIRST =
  "Choose a theme for your store first, under Online store, Storefront.";
const NO_CATEGORIES =
  "Your role cannot change categories, so a redesign with category changes cannot start. Leave the category changes out or ask the store owner.";
const NO_PRODUCTS =
  "Your role cannot add products, so a redesign with products cannot start. Leave the products out or ask the store owner.";
const READY_WAITING = "This chat already has a redesign ready to review.";
const POINT_AT_CARD =
  "Point the merchant at the redesign card already in this chat: they can apply it, publish it or ask for changes. Start a new redesign only if they say they want a new one, with replace_earlier true.";
const DAILY_LIMIT =
  "This store has started as many redesigns as it can today. Try again tomorrow.";
const NO_CREDITS =
  "This store doesn't have enough Mink credits left for a redesign. Buy Mink credits or upgrade under Plans & Billing.";
const ALREADY_BUILDING =
  "A redesign is already being made for this store; its card shows the progress.";
// ★ The active job is one the merchant asked to stop (Stop on its card, or a
//   start this tool withdrew because the chat had already timed out) and its
//   runner has not noticed yet. Since B4 a failed chat run no longer stops the
//   redesign it started, so nothing here says "interrupted".
const EARLIER_STOPPING =
  "The earlier redesign is still stopping. Try again in a minute.";
const NO_PARENT =
  "There is no finished redesign in this chat to change. Start a redesign first, or wait for the card to finish.";
const TOO_MANY_REFINEMENTS =
  "This redesign has been changed as many times as it can be. Start a new redesign to keep going.";

// ---------------------------------------------------------------------------
// Declarations. ★ KEPT SMALL: every declaration is re-sent on each model step
// and prompt-budget.test.ts holds each one under 6,000 characters.
// ---------------------------------------------------------------------------

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    business: {
      type: "string",
      maxLength: 600,
      description:
        "What the store sells and who buys it, in the merchant's words.",
    },
    look: { type: "string", maxLength: 400 },
    audience: { type: "string", maxLength: 300 },
    facts: {
      type: "array",
      maxItems: 15,
      items: { type: "string", maxLength: 200 },
      description:
        "True statements the merchant gave (where they are, how things are made). Never your guesses.",
    },
    avoid: { type: "string", maxLength: 300 },
    language: {
      type: "string",
      maxLength: 40,
      description:
        "English unless the merchant insisted on another language after one reminder.",
    },
  },
  required: ["business"],
  additionalProperties: false,
};

const PRODUCTS_SCHEMA = {
  type: ["array", "null"],
  maxItems: REVAMP_LIMITS.maxProducts,
  items: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 120 },
      description: { type: "string", maxLength: 600 },
      sizes: {
        type: "array",
        minItems: 1,
        maxItems: REVAMP_LIMITS.maxSizes,
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              maxLength: 40,
              description: 'The size, or "" when sold one way only.',
            },
            price: { type: "number", description: "Selling price in rupees." },
            mrp: { type: ["number", "null"] },
          },
          required: ["label", "price"],
          additionalProperties: false,
        },
      },
      photo_url: {
        type: ["string", "null"],
        description:
          "The address of a photo the merchant attached in this chat, or null.",
      },
      category_slug: { type: ["string", "null"], maxLength: 80 },
    },
    required: ["name", "sizes"],
    additionalProperties: false,
  },
  description:
    "Only the merchant's own products with the prices they gave. Never invent one.",
};

const CATEGORIES_SCHEMA = {
  type: ["array", "null"],
  maxItems: REVAMP_LIMITS.maxCategoryChanges,
  items: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["update", "create", "hide"] },
      slug: { type: "string", maxLength: 80 },
      name: { type: "string", maxLength: 80 },
      description: { type: "string", maxLength: 500 },
      new_photo: { type: "boolean" },
      merchant_confirmed: { type: "boolean" },
    },
    required: ["action", "merchant_confirmed"],
    additionalProperties: false,
  },
  description:
    "Only category changes the merchant agreed to, each with merchant_confirmed true; null for none.",
};

const PAGES_SCHEMA = {
  type: ["array", "null"],
  maxItems: REVAMP_LIMITS.maxPages,
  items: { type: "string", maxLength: 60 },
  description:
    'Page slugs ("" is the homepage), or null for every page the redesign may write.',
};

const getRevampContext: MinkTool = {
  declaration: {
    name: "get_storefront_revamp_context",
    description:
      "Read what a redesign of the merchant's store works with: the pages and how much of each is still the theme's, the header and footer, the look, the categories, the products, the store's own facts, why a redesign cannot start now (blocker), and the redesigns already made in this chat (revamps, newest first, with their status). Call it before asking the merchant about a redesign, and before starting or changing one. Read-only.",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "view" },
  available,
  timeoutMs: 15_000,
  repeatSafe: true,
  async execute(actor) {
    const [context, revamps] = await Promise.all([
      readRevampContextForActor(actor),
      conversationRevamps(actor),
    ]);
    return { context, revamps };
  },
};

const startStorefrontRevamp: MinkTool = {
  declaration: {
    name: "start_storefront_revamp",
    description:
      "Start ONE redesign of everything shoppers see: the pages a redesign may write (never the policy pages), the header and footer, the look, one set of new photographs, and the merchant's own products with studio photos. It runs in the background; the chat shows a card with its progress and then a review the merchant applies or publishes. Call get_storefront_revamp_context first, ask the merchant at most three short questions in ONE message (what they sell and who buys it, the look they want, their real products with prices), then call this once. Ask in the same message about categories that came with the theme or do not fit the business; categories holds only agreed changes. Use only what the merchant told you: never invent products, prices, facts or claims.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        brief: BRIEF_SCHEMA,
        products: PRODUCTS_SCHEMA,
        categories: CATEGORIES_SCHEMA,
        pages: PAGES_SCHEMA,
        replace_earlier: {
          type: "boolean",
          description:
            "true only when the merchant wants a new redesign although one in this chat is ready and not yet applied.",
        },
      },
      required: ["brief"],
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "manage" },
  available,
  timeoutMs: 30_000,
  artifact: revampArtifact,
  modelOutput: withoutArtifact,
  async execute(actor, args, context) {
    const read = readRevampRequest(args, "full");
    if (!read.ok) {
      throw new MinkToolInputError(
        issueMessage("start_storefront_revamp", read.issues),
      );
    }
    const request = read.value;
    const blocked = await guardRequest(actor, request, {
      photos: request.products.flatMap((product, index) =>
        product.photoUrl
          ? [{ label: `products[${index}].photo_url`, url: product.photoUrl }]
          : [],
      ),
      newProducts: request.products.length,
    });
    if (blocked) return blocked;
    const conversationId = await conversationForRun(actor);
    if (args.replace_earlier !== true && conversationId) {
      const revamps = await listConversationRevamps({
        storeId: actor.storeId,
        adminId: actor.adminId,
        conversationId,
      });
      const waiting = revamps.find(
        (revamp) => revamp.status === "ready" && !revamp.appliedAt,
      );
      if (waiting) {
        return refused(READY_WAITING, {
          existingRevampId: waiting.id,
          instruction: POINT_AT_CARD,
        });
      }
    }
    return queueRevamp(
      actor,
      {
        kind: "full",
        request,
        conversationId,
        parentId: null,
        parentPlan: null,
      },
      context,
    );
  },
};

const refineStorefrontRevamp: MinkTool = {
  declaration: {
    name: "refine_storefront_revamp",
    description:
      'Change a redesign the merchant already has in this chat, from their words: "make it warmer", "redo the opening photo", "add my products". It builds a new version on top of the earlier one in the background and the card shows its progress. revamp_id defaults to the newest finished redesign of this chat. scope says what may change; everything else is kept. Add products or category changes only when the merchant gave them.',
    parametersJsonSchema: {
      type: "object",
      properties: {
        revamp_id: { type: "string", maxLength: 36 },
        instruction: {
          type: "string",
          minLength: 3,
          maxLength: 600,
          description: "The merchant's own words.",
        },
        scope: {
          type: "object",
          properties: {
            design: {
              type: "boolean",
              description: "Colours, fonts, corners.",
            },
            copy: { type: "boolean", description: "The words." },
            layout: {
              type: "boolean",
              description: "Sections and their order.",
            },
            photos: {
              type: ["array", "null"],
              items: { type: "string", maxLength: 80 },
              description:
                'Photo ids to redraw from get_storefront_revamp_context (revamps[].photos), "opening", ["all"], or null.',
            },
            pages: PAGES_SCHEMA,
            products: { type: "boolean", description: "The products." },
          },
          additionalProperties: false,
        },
        products: PRODUCTS_SCHEMA,
        categories: CATEGORIES_SCHEMA,
      },
      required: ["instruction", "scope"],
      additionalProperties: false,
    },
  },
  permission: { section: "builder", action: "manage" },
  available,
  timeoutMs: 30_000,
  artifact: revampArtifact,
  modelOutput: withoutArtifact,
  async execute(actor, args, context) {
    const conversationId = await conversationForRun(actor);
    const parent = await resolveParent(actor, args.revamp_id, conversationId);
    if (!parent) return refused(NO_PARENT);

    // ★★ AN APPLIED VERSION'S PRODUCTS AND CATEGORY CHANGES ARE ON THE STORE
    //   ALREADY, so the refinement carries only what is not. Carried again,
    //   Apply created every product a second time (with "-2" web addresses)
    //   and the category create, finding its category there, made Apply
    //   refuse the card for good. An unapplied or undone version's are
    //   carried, since this version is the one that will create them.
    // ★★ EVERY EARLIER VERSION, BY ITS STATE NOW (chat-1): the parent may
    //   carry what its own parent has put on the store since it was asked for,
    //   or leave out what that one has since taken back off (revampChainCarry).
    //   The brief, which describes the business, and the page list are the
    //   parent's.
    const chain = await refinementChain(actor, parent);
    const carry = revampChainCarry(
      chain.map((row) => ({
        products: row.request.products,
        categories: row.request.categories,
        live: Boolean(row.appliedAt) && !row.undoneAt,
      })),
    );
    const base = revampRequestToWire({
      ...parent.request,
      products: carry.products,
      categories: carry.categories,
    });
    const baseProducts = base.products as unknown[];
    const baseCategories = base.categories as unknown[];
    const addedProducts = additions(args.products, "products");
    const addedCategories = additions(args.categories, "categories");
    const read = readRevampRequest(
      {
        ...base,
        products: [...baseProducts, ...addedProducts],
        categories: [...baseCategories, ...addedCategories],
        instruction: args.instruction,
        refine_scope: args.scope,
      },
      "refine",
    );
    if (!read.ok) {
      throw new MinkToolInputError(
        issueMessage(
          "refine_storefront_revamp",
          relabel(read.issues, baseProducts.length, baseCategories.length),
        ),
      );
    }
    const parentPlan =
      parent.plan?.stage === "compiled" ? parent.plan.plan : null;
    const keyed = keyRefinementProducts(
      read.value,
      carry.products,
      baseProducts.length,
      carry.usedKeys,
    );
    // ★★ A PHOTO IS NAMED BY THE PARENT PLAN'S OWN IDS (chat-2). The compiler
    //   redraws only shots the parent plan has, so a guessed id ("hero" for
    //   hero-slide-1) silently redrew nothing while the refinement was used
    //   up. "opening" names the homepage's opening photographs; anything else
    //   unknown is refused with the ids there are.
    const scope = keyed.refineScope;
    const request: RevampRequest = scope
      ? {
          ...keyed,
          refineScope: {
            ...scope,
            photos: resolveRedrawScope(scope.photos, parentPlan),
          },
        }
      : keyed;
    // ★ The parent's products were checked when it started; only the new
    //   ones can carry a photo nobody has looked at yet.
    const newOnes = request.products.slice(baseProducts.length);
    const blocked = await guardRequest(actor, request, {
      photos: newOnes.flatMap((product, index) =>
        product.photoUrl
          ? [{ label: `products[${index}].photo_url`, url: product.photoUrl }]
          : [],
      ),
      // Every product in the request is created at Apply: the carried ones of
      // an unapplied parent with the new ones.
      newProducts: request.products.length,
    });
    if (blocked) return blocked;
    if ((await countRefinements(parent.id)) >= REVAMP_LIMITS.maxRefinements) {
      return refused(TOO_MANY_REFINEMENTS);
    }
    return queueRevamp(
      actor,
      {
        kind: "refine",
        request,
        conversationId,
        parentId: parent.id,
        // The plan the runner hands the compiler as the refinement's previous.
        parentPlan,
      },
      context,
    );
  },
};

export const minkStorefrontRevampTools = [
  getRevampContext,
  startStorefrontRevamp,
  refineStorefrontRevamp,
];

// ---------------------------------------------------------------------------
// The shared path.
// ---------------------------------------------------------------------------

/**
 * The refusals both tools share, in the order a merchant could act on them.
 * Null when the request may go ahead.
 */
async function guardRequest(
  actor: MinkActorContext,
  request: RevampRequest,
  input: { photos: Array<{ label: string; url: string }>; newProducts: number },
): Promise<Record<string, unknown> | null> {
  if (await themeIsPending(actor.storeId)) return refused(THEME_FIRST);
  if (
    request.categories.length > 0 &&
    !can(actor.permissions, "categories", "manage", actor.isSuperadmin)
  ) {
    return refused(NO_CATEGORIES);
  }
  if (
    request.products.length > 0 &&
    !can(actor.permissions, "products", "manage", actor.isSuperadmin)
  ) {
    return refused(NO_PRODUCTS);
  }
  if (input.photos.length > 0) {
    const owned = await withService((db) =>
      selectOwnedStorefrontImageUrls(
        db,
        actor.storeId,
        input.photos.map((photo) => photo.url),
      ),
    );
    const foreign = input.photos.filter((photo) => !owned.has(photo.url));
    if (foreign.length > 0) {
      // ★ A photo the store does not own is never fetched: the job would
      //   otherwise turn someone else's picture into this store's product.
      throw new MinkToolInputError(
        `${foreign.map((photo) => photo.label).join(", ")}: not a photo this store owns. Ask the merchant to attach the photo in this chat and use the address it is saved under, or set photo_url to null.`,
      );
    }
  }
  if (input.newProducts > 0) {
    const capacity = await withService((db) =>
      getProductCreateCapacity(db, actor.storeId, input.newProducts),
    );
    if (capacity.allowed < input.newProducts) return refused(capacity.error);
  }
  return null;
}

/**
 * Claim the day's start, decide the budget, queue the job and kick the
 * runner. ★ The claim is given back whenever no job comes of it, so a refused
 * or failed attempt never uses up a start.
 *
 * ★★ A REDESIGN NEVER STARTS AFTER THE CHAT SAID "TOOK TOO LONG" (robustness
 *   audit B6). `context` is the registry's: its signal fires at the tool's
 *   deadline or when the run stops, and `commit` refuses a write once the time
 *   is up. So a stopped run queues nothing (checked before the start is
 *   claimed, and again by `commit` at the insert), and the job insert, the one
 *   write that starts a redesign, is the commit. A run that stops WHILE the
 *   insert is under way holds the timeout for the commit's grace; an insert
 *   that outlives even the grace is withdrawn below, because the chat has
 *   already told the merchant the tool did not finish.
 * ★ `MinkToolTimeoutError` is never caught here: the registry turns it into
 *   the tool's timeout answer, and `finally` gives the start back.
 * ★ Without a context (a caller outside the registry) the job is inserted
 *   directly, as before.
 */
async function queueRevamp(
  actor: MinkActorContext,
  input: {
    kind: RevampKind;
    request: RevampRequest;
    conversationId: string | null;
    parentId: string | null;
    /** A refinement's parent plan, which decides what it carries over. */
    parentPlan: RevampSitePlan | null;
  },
  context?: MinkToolContext,
): Promise<Record<string, unknown>> {
  if (context?.signal.aborted) throw new MinkToolTimeoutError();
  // ★ The same counter a failed redesign gives its start back to (B5),
  //   defined once beside the job code.
  const limit = revampStartLimit(actor.storeId);
  const claim = await claimSpendLimits([limit]);
  if (!claim.ok) return refused(DAILY_LIMIT);
  let release = true;
  try {
    const budget = await budgetFor(actor, input);
    if (budget === "refused") return refused(NO_CREDITS);
    const insert = () =>
      createRevampJob({
        actor,
        conversationId: input.conversationId,
        kind: input.kind,
        request: input.request,
        parentId: input.parentId,
        budgetCredits: budget,
      });
    const created = context ? await context.commit(insert) : await insert();
    if (!created.ok) {
      if (await isStopping(actor, created.activeId)) {
        return refused(EARLIER_STOPPING);
      }
      return refused(ALREADY_BUILDING, { existingRevampId: created.activeId });
    }
    if (context?.signal.aborted) {
      // ★★ The insert landed after the commit's grace ran out: the chat has
      //   been told the tool took too long and shows no card, so the job is
      //   withdrawn before anything runs it (it was never kicked). A stopped
      //   queued job is cancelled at once and gives the free redesign back;
      //   the start is given back too, by `finally`.
      if (!(await withdrawJob(actor, created.job.id))) release = false;
      throw new MinkToolTimeoutError();
    }
    release = false;
    kick(created.job.id);
    return started(created.job, input.kind);
  } finally {
    // ★ Only to the window that counted the claim, when the database said
    //   which one (spend-limits.ts).
    if (release) {
      if (claim.claimedAt) {
        await releaseSpendLimits([limit], { claimedAt: claim.claimedAt });
      } else {
        await releaseSpendLimits([limit]);
      }
    }
  }
}

/**
 * Stop a job this tool queued and then had to take back. True when it is
 * stopped or asked to stop. ★ False keeps the day's start spent: a job that
 * could not be withdrawn may still be run by the stalled-revamp sweep, and
 * the operator line names it so it can be stopped by hand.
 * ★★ A job that had already FAILED (or finished) is not withdrawn by this:
 *   a failure gives its own start back (jobs.ts, B5), so answering true for it
 *   would give the same start back twice.
 */
async function withdrawJob(
  actor: MinkActorContext,
  revampId: string,
): Promise<boolean> {
  try {
    const view = await cancelRevamp(actor, revampId);
    if (view) return view.status === "cancelled" || view.cancelRequested;
  } catch (error) {
    logError("mink.revamp: late start not withdrawn", loggableError(error), {
      revampId,
      storeId: actor.storeId,
    });
    return false;
  }
  logError("mink.revamp: late start not withdrawn", undefined, {
    revampId,
    storeId: actor.storeId,
  });
  return false;
}

/**
 * The budget a job is given: the store's remaining credits less what the run
 * starting it may still cost, or null when the plan is unmetered. ★ Passed even
 * when the redesign looks free, because jobs.ts decides `free` under the
 * store's lock and drops the budget then; a paid job that got none would have
 * nothing bounding its spend.
 *
 * ★★ THE STARTING RUN IS SETTLED FROM THE SAME BALANCE, after this tool returns
 *   (the stream route's settleMinkRunCredits), so the whole balance was a
 *   budget the card could never be paid from: the fit filled it, the run took
 *   its share, and the charge failed only after every paid model and photo
 *   call. A paid start whose budget cannot cover the card's fixed part is
 *   refused here instead, where it costs nothing.
 * ★ The fixed part is assemble.ts's own ceiling, from the carry rules the
 *   budget fit follows, so the two cannot disagree: a refinement pays only
 *   for what it does not carry over (f-6), a full revamp for all of it.
 */
async function budgetFor(
  actor: MinkActorContext,
  input: {
    kind: RevampKind;
    request: RevampRequest;
    parentPlan: RevampSitePlan | null;
  },
): Promise<number | null | "refused"> {
  const [free, headroom] = await Promise.all([
    input.kind === "full" ? freeRevampAvailable(actor.storeId) : false,
    imageCreditHeadroom(actor, getMinkConfig().chargeCredits),
  ]);
  if (headroom.remaining === null) return null;
  // Never below nothing: the job refuses a negative budget.
  const budget = Math.max(0, headroom.remaining - MINK_MAX_RUN_CREDITS);
  const fixed = revampFixedCreditCeiling(input.request, input.parentPlan);
  if (!free && budget < fixed) return "refused";
  return budget;
}

/**
 * Whether the store's active revamp is one asked to stop that its runner has
 * not noticed yet. Best effort: an unreadable job reads as building.
 */
async function isStopping(
  actor: MinkActorContext,
  revampId: string,
): Promise<boolean> {
  try {
    const job = await readRevampJob(revampId);
    return job?.storeId === actor.storeId && job.cancelRequestedAt !== null;
  } catch {
    return false;
  }
}

function kick(revampId: string) {
  // ★ Not awaited: the merchant's answer must not wait on the runner saying
  //   it heard. A kick that is lost is retried by the card's status poll.
  void kickRevampRunner(revampId).catch((error: unknown) => {
    logWarn("mink.revamp: kick failed", {
      revampId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function started(job: RevampJobRow, kind: RevampKind): Record<string, unknown> {
  const artifact: RevampArtifact = {
    type: "storefront_revamp",
    revampId: job.id,
    kind,
    status: job.status,
  };
  return {
    status: "started",
    revampId: job.id,
    instruction: kind === "full" ? START_INSTRUCTION : REFINE_INSTRUCTION,
    artifact,
  };
}

function refused(
  reason: string,
  extra: { instruction?: string; existingRevampId?: string } = {},
): Record<string, unknown> {
  return {
    status: "not_started",
    reason,
    instruction: extra.instruction ?? RELAY_INSTRUCTION,
    ...(extra.existingRevampId
      ? { existingRevampId: extra.existingRevampId }
      : {}),
  };
}

function revampArtifact(
  output: Record<string, unknown>,
): MinkArtifact | undefined {
  // ★ The card reads the revamp by id, so only an artifact that passes the
  //   contract's own check rides through to it.
  return isRevampArtifact(output.artifact) ? output.artifact : undefined;
}

/** ★ The model gets whether it started, never the card (or any figure on it). */
function withoutArtifact(
  output: Record<string, unknown>,
): Record<string, unknown> {
  const forModel = { ...output };
  delete forModel.artifact;
  return forModel;
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** The conversation the current run belongs to, from its run row. */
async function conversationForRun(
  actor: MinkActorContext,
): Promise<string | null> {
  const runId = actor.runId;
  if (!runId) return null;
  const rows = await withService((db) =>
    db
      .select({ conversationId: minkRuns.conversationId })
      .from(minkRuns)
      .where(and(eq(minkRuns.id, runId), eq(minkRuns.storeId, actor.storeId)))
      .limit(1),
  );
  return rows[0]?.conversationId ?? null;
}

async function conversationRevamps(
  actor: MinkActorContext,
): Promise<Array<Record<string, unknown>>> {
  try {
    const conversationId = await conversationForRun(actor);
    if (!conversationId) return [];
    const entries = await listConversationRevamps({
      storeId: actor.storeId,
      adminId: actor.adminId,
      conversationId,
    });
    // ★ The photos of the redesign a refinement builds on by default, so the
    //   model can name the one the merchant means (chat-2).
    const refinable = entries.find(isRefinableRevamp);
    const photos = refinable ? await photosOf(actor, refinable.id) : null;
    return entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      summary: entry.summary,
      appliedAt: entry.appliedAt,
      publishedAt: entry.publishedAt,
      undoneAt: entry.undoneAt,
      createdAt: entry.createdAt,
      ...(entry === refinable && photos ? { photos } : {}),
    }));
  } catch (error) {
    // ★ The context still answers; starting re-reads the list and fails closed.
    logWarn("mink.revamp: conversation revamps unreadable", {
      storeId: actor.storeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function themeIsPending(storeId: string): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  const settings = rows[0]?.settings;
  return isThemePending({
    settings:
      settings && typeof settings === "object"
        ? (settings as Record<string, unknown>)
        : null,
  });
}

async function freeRevampAvailable(storeId: string): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .select({ id: minkRevamps.id })
      .from(minkRevamps)
      .where(
        and(
          eq(minkRevamps.storeId, storeId),
          eq(minkRevamps.kind, "full"),
          eq(minkRevamps.free, true),
          inArray(minkRevamps.status, FREE_HOLDING_STATUSES),
        ),
      )
      .limit(1),
  );
  return !rows[0];
}

/**
 * The redesign a refinement builds on: the one named, or the newest finished
 * one of this chat. ★ Only the requester's own, and only one that finished:
 * a queued or failed revamp has no version to build on.
 * ★★ ONE RULE WITH THE ROUTE (chat-4): a version a newer one replaced after
 *    it was applied is still on the store, so it is refinable; the route
 *    counted it as ready, and refusing it here left a chat whose newest
 *    version was undone with only a tool that always refused.
 */
async function resolveParent(
  actor: MinkActorContext,
  rawId: unknown,
  conversationId: string | null,
): Promise<RevampJobRow | null> {
  if (rawId !== undefined && rawId !== null && rawId !== "") {
    if (typeof rawId !== "string") return null;
    const named = await readRevampForActor(actor, rawId.trim());
    return named && isFinishedRevampVersion(named) ? named : null;
  }
  if (!conversationId) return null;
  const revamps = await listConversationRevamps({
    storeId: actor.storeId,
    adminId: actor.adminId,
    conversationId,
  });
  const newest = revamps.find(isRefinableRevamp);
  if (!newest) return null;
  const row = await readRevampForActor(actor, newest.id);
  return row && isFinishedRevampVersion(row) ? row : null;
}

/** The most versions one redesign can have: the full one and its refinements. */
const CHAIN_LIMIT = REVAMP_LIMITS.maxRefinements + 1;

/**
 * The version a refinement builds on, then each earlier version of the same
 * redesign up to the full one, newest first. ★ The requester's own rows only
 * (`readRevampForActor`), and a version that cannot be read ends the chain:
 * the carry then errs towards carrying, which Apply's own checks refuse,
 * never towards dropping a product.
 */
/** The word a refinement may use for the homepage's opening photographs. */
const OPENING_PHOTO = "opening";
/** How much of a shot's subject the model is shown. */
const PHOTO_SHOWS_MAX = 80;

interface RedrawablePhoto {
  id: string;
  /** Where the merchant sees it, in the card's own words. */
  where: string;
  /** What it shows, as the plan described it. */
  shows: string;
}

/** A finished redesign's photos, for the context read. Null when unreadable. */
async function photosOf(
  actor: MinkActorContext,
  revampId: string,
): Promise<RedrawablePhoto[] | null> {
  try {
    const row = await readRevampForActor(actor, revampId);
    const plan = row?.plan?.stage === "compiled" ? row.plan.plan : null;
    return plan ? redrawablePhotos(plan) : null;
  } catch (error) {
    logWarn("mink.revamp: redesign photos unreadable", {
      storeId: actor.storeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The photographs a refinement of `plan` can name, in the plan's order: each
 * shot placed on a page or a category, with where it is (the card's words)
 * and what it shows. A shot on no page is left out: nobody can see it.
 */
function redrawablePhotos(plan: RevampSitePlan): RedrawablePhoto[] {
  const pages = new Map(plan.pages.map((page) => [page.slug, page]));
  const opening = revampOpeningBinding(plan);
  const photos: RedrawablePhoto[] = [];
  for (const shot of plan.shots) {
    const binding = plan.bindings.find((entry) => entry.shotId === shot.id);
    if (!binding) continue;
    let where: string;
    if (binding.pageSlug === "@category") {
      where = `${binding.sectionId} category`;
    } else {
      const page = pages.get(binding.pageSlug);
      const section = page?.sections.find((s) => s.id === binding.sectionId);
      if (!page || !section) continue;
      const isOpening =
        binding.pageSlug === "" && opening?.sectionId === binding.sectionId;
      where = `${revampPageName(page.slug, page.title)}, ${isOpening ? "opening photo" : revampSectionLabel(section)}`;
    }
    const shows = typeof shot.subject === "string" ? shot.subject.trim() : "";
    photos.push({ id: shot.id, where, shows: shows.slice(0, PHOTO_SHOWS_MAX) });
    if (photos.length >= REVAMP_LIMITS.maxShots) break;
  }
  return photos;
}

/** The shots of the homepage's opening section (a carousel has several). */
function openingShotIds(plan: RevampSitePlan): string[] {
  const opening = revampOpeningBinding(plan);
  if (!opening) return [];
  return [
    ...new Set(
      plan.bindings
        .filter(
          (binding) =>
            binding.pageSlug === "" && binding.sectionId === opening.sectionId,
        )
        .map((binding) => binding.shotId),
    ),
  ];
}

/**
 * A refinement's photos to redraw, as the parent plan's own shot ids. ★ Ids
 * are matched the way the compiler matches a redraw (`sanitizeShotId`), a
 * shot the plan has wins over the word "opening", and an id the plan does
 * not have is refused naming every photo it has: guessed, it was a silent
 * no-op the merchant still paid a refinement for.
 */
function resolveRedrawScope(
  photos: string[] | "all" | null,
  plan: RevampSitePlan | null,
): string[] | "all" | null {
  if (photos === null || photos === "all") return photos;
  const ids = new Set((plan?.shots ?? []).map((shot) => shot.id));
  const opening = plan ? openingShotIds(plan) : [];
  const resolved: string[] = [];
  const unknown: string[] = [];
  const add = (id: string) => {
    if (!resolved.includes(id)) resolved.push(id);
  };
  for (const raw of photos) {
    const id = sanitizeShotId(raw) ?? raw;
    if (ids.has(id)) add(id);
    else if (raw.trim().toLowerCase() === OPENING_PHOTO && opening.length) {
      opening.forEach(add);
    } else unknown.push(raw);
  }
  if (!unknown.length) return resolved;
  const named = plan ? redrawablePhotos(plan) : [];
  const missing = unknown.map((id) => `"${id}"`).join(", ");
  throw new MinkToolInputError(
    named.length
      ? `scope.photos: this redesign has no photo ${missing}. Name photos by id: ${named.map((photo) => `${photo.id} (${photo.where})`).join("; ")}. Or use "opening" for the homepage's opening photo, or ["all"] for every photo.`
      : `scope.photos: this redesign has no photo ${missing}, and none to name. Use ["all"] for every photo, or leave photos out.`,
  );
}

async function refinementChain(
  actor: MinkActorContext,
  parent: RevampJobRow,
): Promise<RevampJobRow[]> {
  const chain = [parent];
  let next = parent.parentId;
  while (next && chain.length < CHAIN_LIMIT) {
    const row = await readRevampForActor(actor, next);
    if (!row || chain.some((version) => version.id === row.id)) break;
    chain.push(row);
    next = row.parentId;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

function additions(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MinkToolInputError(
      `${label} must be a list of what the merchant added, or left out.`,
    );
  }
  return value;
}

function issueMessage(tool: string, issues: string[]): string {
  return `Fix these and call ${tool} again:\n- ${issues.join("\n- ")}`;
}

/**
 * Issues from a refinement name positions in the merged list; the model sent
 * only the additions, so positions are moved back to its own numbering.
 */
function relabel(
  issues: string[],
  productOffset: number,
  categoryOffset: number,
): string[] {
  const shift = (name: string, offset: number) => (_: string, raw: string) => {
    const index = Number(raw);
    return index < offset
      ? `the earlier redesign's ${name} ${index + 1}`
      : `${name}[${index - offset}]`;
  };
  return issues.map((issue) =>
    issue
      .replace(/\bproducts\[(\d+)\]/g, shift("products", productOffset))
      .replace(/\bcategories\[(\d+)\]/g, shift("categories", categoryOffset))
      .replace(/\brefine_scope\b/g, "scope"),
  );
}
