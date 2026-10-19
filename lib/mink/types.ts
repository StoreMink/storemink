import type { MinkFormPrefill } from "./form-prefill";
import type { MinkHighlight } from "./guide-targets";
import type {
  DesignFont,
  DesignPaletteToken,
  DesignShapeKey,
} from "@/lib/chrome/design";
import type { SectionType } from "@/lib/sections/registry";
import type {
  PermissionAction,
  RolePermissions,
} from "@/app/dashboard/lib/permissions";
import type {
  MinkDraftContent,
  MinkDraftCreditSource,
  MinkDraftField,
  MinkDraftKind,
  MinkDraftStatus,
} from "./draft-types";
import type { MinkMediaPurpose } from "./media-generation-contract";
import type {
  MinkWorkflowStatus,
  MinkWorkflowTemplate,
} from "./workflow-types";

export type MinkPlan = "free" | "basic" | "pro";

export type MinkSelectedResource = {
  type: "product" | "order";
  id: string;
};

export type MinkFilter = {
  label: string;
  value: string;
};

/**
 * What a Phase 9B layout proposal changes, for the human review card.
 *
 * ★ IT LIVES HERE, NOT IN THE CONTRACT, because the contract is `server-only`
 * and this shape is rendered by a dashboard client component. `import type` is
 * erased, so the compiler would allow it either way -- and that is exactly the
 * hazard: the day somebody reaches for a VALUE from the same module the build
 * breaks with a `server-only` error rather than a type error. The two halves of
 * the split are `lib/logs/failure-types.ts`'s rule.
 */
export interface MinkStorefrontLayoutSectionRef {
  id: string;
  /**
   * ★ THE TYPE RIDES ALONG BECAUSE AN ID IS NOT A NAME. Section ids are opaque
   * strings, so a card listing "Removed: sec_8f2a1c" tells a merchant nothing
   * about what they are being asked to approve deleting. The card turns the
   * type into a label through `SECTION_TYPE_META`, which is the same
   * vocabulary the Builder's own outline uses -- so the two agree by
   * construction rather than through a second copy of the labels.
   */
  type: SectionType;
}

export interface MinkStorefrontLayoutSummary {
  /** Sections present before and after, in their PROPOSED order. */
  kept: MinkStorefrontLayoutSectionRef[];
  added: MinkStorefrontLayoutSectionRef[];
  removed: MinkStorefrontLayoutSectionRef[];
  /** Order of the SURVIVING sections changed (a pure add is not a reorder). */
  reordered: boolean;
  /**
   * Pictures the proposal PUTS ON THE PAGE, newest-change first, capped.
   *
   * ★★ WITHOUT THESE THE CARD CANNOT SHOW WHAT IT IS ASKING TO APPROVE. It
   * renders section LABELS -- "Carousel · 1 slide", "0 added, 0 removed" -- so
   * a merchant who asked for a banner got a text list and no banner. Observed:
   * a proposal that correctly used the store's own product photograph was read
   * as having ignored it, and the merchant asked for a generated image instead,
   * which replaced their real one. The card was right and unreadable.
   *
   * ⚠ A URL here becomes an `<img src>` in the dashboard, restored from stored
   * conversation JSON -- so the parser re-checks every one against our own
   * media hosts (9E's rule for generated images, for the same reason: a forged
   * history row must not turn into a request to a third-party address).
   */
  previewImageUrls?: string[];
}

/**
 * What a Phase 9C design proposal changes, for the human review card.
 *
 * ★ ONLY THE FIELDS THAT MOVED, each carrying the theme value underneath it.
 * A design override is three-state -- set, cleared, or never touched -- and a
 * card that renders an empty swatch for "cleared" tells a merchant nothing
 * about what their shop will actually look like. `themeDefault` is the colour
 * the storefront paints when the override goes away, so "back to the theme"
 * can be shown as a real value rather than as an absence.
 */
export interface MinkStorefrontDesignSummary {
  palette: Array<{
    token: DesignPaletteToken;
    before: string | null;
    after: string | null;
    themeDefault: string | null;
  }>;
  fonts: Array<{
    slot: "body" | "display";
    before: DesignFont | null;
    after: DesignFont | null;
    themeDefault: DesignFont | null;
  }>;
  shape: Array<{
    key: DesignShapeKey;
    before: number | null;
    after: number | null;
    themeDefault: number | null;
  }>;
  /** Recomputed on read; empty on any proposal the contract accepted. */
  contrastIssues: string[];
}

export type MinkArtifact =
  | {
      type: "product_import";
      fileId: string;
      filename: string;
      rows: number;
      errorCount: number;
      warningCount: number;
      changes: string[];
      jobId: string | null;
      issues: Array<{
        line: number;
        column: string | null;
        severity: "error" | "warning";
        message: string;
        value?: string | null;
      }>;
    }
  | {
      type: "clarification";
      title: string;
      question: string;
      choices: Array<{
        label: string;
        description?: string;
        prompt: string;
      }>;
    }
  | {
      type: "metrics";
      title: string;
      currency?: string;
      metrics: Array<{
        label: string;
        value: number;
        format: "number" | "currency" | "percent";
        trendPercent?: number | null;
      }>;
      filters: MinkFilter[];
      dataAsOf?: string;
      dashboardPath?: string;
    }
  | {
      type: "catalog";
      title: string;
      counts: {
        total: number;
        published: number;
        unpublished: number;
        draft: number;
        archived: number;
        inventoryItems: number | null;
        lowStock: number | null;
        outOfStock: number | null;
      };
      items: Array<{
        id: string;
        title: string;
        variant?: string;
        sku: string;
        publicationStatus: string;
        publicationTags: string[];
        inventoryStatus: string | null;
        stock: number | null;
        threshold: number | null;
        dashboardPath?: string;
      }>;
      locations?: Array<{
        id: string;
        name: string;
        type: string;
        inventoryItems: number;
        trackedItems: number;
        lowStock: number;
        outOfStock: number;
        dashboardPath?: string;
        prompt: string;
      }>;
      filters: MinkFilter[];
      dataAsOf?: string;
      dashboardPath?: string;
      inventoryDashboardPath?: string;
      truncated?: boolean;
      locationsTruncated?: boolean;
    }
  | {
      type: "records";
      title: string;
      recordType:
        | "order"
        | "product"
        | "inventory"
        | "storefront"
        | "offer"
        | "blog";
      records: Array<{
        id: string;
        title: string;
        subtitle?: string;
        value?: string;
        status?: string;
        dashboardPath?: string;
      }>;
      filters: MinkFilter[];
      dataAsOf?: string;
      dashboardPath?: string;
      truncated?: boolean;
    }
  | {
      type: "sources";
      title: string;
      sources: Array<{
        title: string;
        excerpt?: string;
        url: string;
      }>;
      query: string;
    }
  | {
      type: "proposal";
      draftId: string;
      draftKind: MinkDraftKind;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      before: MinkDraftField[];
      after: MinkDraftField[];
      content: MinkDraftContent;
      status: MinkDraftStatus;
      currentVersion: number;
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "storefront_code_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      explanation: string;
      target: {
        pageSlug: string;
        sectionId: string;
        expectedPageVersion: string;
        expectedSectionDigest: string;
      };
      patchDigest: string;
      changedFields: Array<"html" | "css" | "js" | "height">;
      beforeCharacters: number;
      afterCharacters: number;
      validationChecks: string[];
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "storefront_layout_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      explanation: string;
      target: {
        pageSlug: string;
        expectedPageVersion: string;
        expectedSectionsDigest: string;
      };
      patchDigest: string;
      summary: MinkStorefrontLayoutSummary;
      sectionCount: number;
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "builder_proposal";
      draftId: string;
      title: string;
      operation: import("./builder-contract").BuilderOperation;
      pageSlug: string;
      explanation: string;
      changes: import("./builder-contract").BuilderChange[];
      live: boolean;
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "storefront_design_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      explanation: string;
      target: { expectedDesignDigest: string };
      patchDigest: string;
      summary: MinkStorefrontDesignSummary;
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "media_image_proposal";
      draftId: string;
      title: string;
      destinationLabel: string;
      destinationPath: string;
      /**
       * The image itself.
       *
       * ⚠ PUBLIC, like every other object in the media bucket (uniform
       * bucket-level access, §7), and saved into the Media Library as part of
       * generation so the same run may cite it in a layout proposal. The card
       * renders it directly; a proposal that only described the picture would
       * ask a merchant to approve something nobody has looked at.
       */
      url: string;
      alt: string;
      prompt: string;
      /** Number of verified current-store source images sent to the model. */
      referenceImageCount?: number;
      purpose: MinkMediaPurpose;
      aspectRatio: string;
      placement: string;
      saved: boolean;
      status: "private_preview";
      expectedCredits: number;
      chargedCredits: number;
      creditSource: MinkDraftCreditSource;
    }
  | {
      type: "workflow";
      runId: string;
      template: MinkWorkflowTemplate;
      title: string;
      description: string;
      status: MinkWorkflowStatus;
      currentStep: number;
      totalSteps: number;
    }
  | {
      /**
       * A dashboard page Mink was asked to open, optionally with a product
       * form filled in. The card offers the page as a button and the panel
       * opens it client-side when the artifact arrives live, so the chat
       * stays open beside the page. `path` is re-checked by the parser to be
       * a `/dashboard` path; nothing here is a URL the model composed freely.
       */
      type: "navigation";
      title: string;
      path: string;
      label: string;
      prefill?: MinkFormPrefill;
      /** A control on the opened page to point out (lib/mink/guide-targets.ts). */
      highlight?: MinkHighlight;
    }
  | {
      /**
       * A small time series or breakdown drawn inline as an SVG chart.
       *
       * `summary` leads the card with the period's total and a trend against
       * the comparison period; `goodWhen: "down"` is for measures where a
       * rise is bad news (discounts, returns). `panels` carries a second
       * measure over the SAME grouping and period, drawn beside the first as
       * a small multiple: one tool output yields one artifact, so two
       * measures travel in one card rather than as two artifacts.
       */
      type: "chart";
      title: string;
      kind: "line" | "bar";
      format: "number" | "currency" | "percent";
      currency?: string;
      series: Array<{
        label: string;
        points: Array<{ label: string; value: number }>;
      }>;
      summary?: {
        total: number;
        previousTotal?: number;
        trendPercent?: number | null;
        comparisonLabel?: string;
        goodWhen?: "up" | "down";
      };
      panels?: Array<{
        title: string;
        kind: "line" | "bar";
        format: "number" | "currency" | "percent";
        currency?: string;
        series: Array<{
          label: string;
          points: Array<{ label: string; value: number }>;
        }>;
        summary?: {
          total: number;
          previousTotal?: number;
          trendPercent?: number | null;
          comparisonLabel?: string;
          goodWhen?: "up" | "down";
        };
      }>;
      filters: MinkFilter[];
      dataAsOf?: string;
      dashboardPath?: string;
    };

export type MinkFeedbackRating = "helpful" | "unhelpful";
export type MinkFeedbackIssue =
  | "incorrect"
  | "missing_context"
  | "privacy"
  | "slow"
  | "other";

/**
 * Trusted, server-derived identity for one Mink run. Model-generated input must
 * never be able to replace any field on this object.
 */
export interface MinkActorContext {
  storeId: string;
  adminId: string;
  email: string | null;
  roleSlug: string;
  permissions: RolePermissions;
  isSuperadmin: boolean;
  effectivePlan: MinkPlan;
  /** Null means unrestricted; an array is the exact server-derived location scope. */
  locationIds: string[] | null;
  analyticsTimeZone: string;
  currency: string;
  defaultLowStockThreshold: number;
  currentPath?: string | null;
  selectedResource?: MinkSelectedResource | null;
  /** Trusted run id is attached only after the run row is created. */
  runId?: string;
  /** Operator-controlled Phase 3 access; never inferred from the prompt. */
  draftingEnabled?: boolean;
  /** Store-authored style context. It may shape copy but never authority. */
  brandVoice?: string;
  /**
   * How the merchant will take the answer in: `spoken` when the message came
   * from the hands-free voice chat, so the reply opens with a short spoken
   * block before the written answer. Absent means written.
   */
  answerMedium?: MinkAnswerMedium;
  requestId: string;
}

export type MinkAnswerMedium = "written" | "spoken";

export interface MinkToolPermission {
  section: string;
  action: PermissionAction;
}

export interface MinkToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface MinkToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface MinkToolResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
  artifact?: MinkArtifact;
}

export interface MinkUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  /**
   * The SUBSET of `promptTokens` the provider served from a context cache, so
   * `promptTokens - cachedTokens` is what was charged at the full input rate.
   * The provider documents `promptTokenCount` as already including cached
   * content, so this must never be added to it.
   *
   * Recorded as a raw fact rather than folded into a cost: the system prompt
   * plus tool declarations are a deterministic ~10.5k-token prefix re-sent on
   * every step of every run, and it is the single largest cost line. Whether a
   * cache is actually serving it is otherwise invisible.
   */
  cachedTokens: number;
  /**
   * The FIRST model turn's prompt count — the system prompt, the permitted
   * tool declarations, any memories and the merchant's message.
   *
   * Every later step re-sends it, so a run's prompt total is roughly
   * `steps × this` plus the tool results and model turns that accumulated
   * along the way. The charge keeps this initial prompt once, because it also
   * contains merchant-authored context, and removes only the repeated copies.
   * `estimateMinkCost` still counts every token we really pay for.
   *
   * ⚠ NOT SUMMED by `addUsage` — the first turn's value wins, including zero,
   * because it is a property of where the run STARTED rather than a per-step
   * counter. Zero means unknown (a provider that reported no usage, or a row
   * written before this was recorded), and every consumer falls back to
   * charging the whole prompt, which is what it did before.
   */
  basePromptTokens: number;
}

export interface MinkModelTurn {
  text: string;
  functionCalls: MinkToolCall[];
  usage: MinkUsage;
  /** Provider-call retries consumed while producing this turn. */
  retryCount: number;
}

/**
 * How a model turn is delivered while it is still being generated.
 *
 * ★ `onDelta` carries only VISIBLE text (thought parts are never forwarded)
 * in the order the provider produced it. `onReset` fires when fragments
 * already delivered must be thrown away: a retried provider call re-sends
 * the whole turn, and a turn that ends in a function call is working-out,
 * not the answer. A session that cannot stream may ignore both and return
 * the finished turn; the orchestrator never depends on a delta arriving.
 */
export interface MinkStreamOptions {
  onDelta?: (text: string) => void;
  onReset?: () => void;
}

export interface MinkModelSession {
  sendUserMessage(
    message: string,
    options?: MinkStreamOptions,
  ): Promise<MinkModelTurn>;
  sendToolResponses(
    responses: MinkToolResponse[],
    options?: MinkStreamOptions,
  ): Promise<MinkModelTurn>;
  /**
   * The model answering right now: the lite model until a restart, the main
   * model after one, the fallback once the main model has failed in this run.
   * Absent means the configured model.
   */
  readonly model?: string;
  /** The Vertex location of `model`. Absent means the configured location. */
  readonly location?: string;
  /**
   * Swap a narrowed session for one with every permitted tool, on the main
   * model, keeping the stored conversation. False when there is nothing to
   * widen: the run was never narrowed, or it already was widened.
   */
  restartWithAllTools?(): boolean;
}

export type MinkRunEvent =
  | { type: "text_delta"; text: string }
  /**
   * Text already streamed is withdrawn. `retry`: the provider call failed half
   * way and the turn is being asked again. `restart`: the turn asked for more
   * tools and the run starts again with all of them. `tool_call`: the turn
   * ended in a function call, so what it wrote was working-out (a voice
   * turn's spoken acknowledgement survives this one; see the stream route).
   */
  | { type: "text_reset"; reason: "retry" | "restart" | "tool_call" }
  | { type: "tool_call"; sequence: number; call: MinkToolCall }
  | {
      type: "tool_result";
      sequence: number;
      name: string;
      ok: boolean;
      errorCode?: string;
      artifact?: MinkArtifact;
    }
  /**
   * A narrowed run asked for more tools and started again with all of them.
   * `usage` is the abandoned attempt's, which the run's own usage excludes.
   */
  | { type: "tools_restarted"; abandonedModel: string; usage: MinkUsage };

export interface MinkRunResult {
  text: string;
  model: string;
  steps: number;
  toolCalls: number;
  retryCount: number;
  usage: MinkUsage;
  artifacts: MinkArtifact[];
  /**
   * Set when the run restarted with every tool. ★ The abandoned attempt's
   * tokens are reported here and NOT in `usage`: a routing miss is
   * StoreMink's to pay for, and `usage` is what the merchant is metered on.
   */
  restart?: {
    abandonedModel: string;
    usage: MinkUsage;
    steps: number;
    toolCalls: number;
  };
}

export interface MinkRunProgress {
  steps: number;
  toolCalls: number;
  retryCount: number;
  usage: MinkUsage;
}
