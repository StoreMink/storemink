/**
 * The approval and result shapes for applying one personalised storefront.
 *
 * ★ THE APPROVAL CARRIES DIGESTS, NOT THE PLAN. The plan holds whole section
 *   lists and lives on the draft row; copying it onto the approval would store
 *   it twice more. Execution re-reads the plan and every target and refuses
 *   unless each hashes to what was approved (9B's rule).
 *
 * ★ ONE SHAPE FOR BOTH PLAN VERSIONS. A storefront revamp's card applies a
 *   plan version 2 through the same approval, so the same eight values bind
 *   it; only how each digest is computed differs (revamp/apply-v2.ts).
 *
 * Client-safe: the review card reads these.
 */

export interface MinkStorefrontPersonalizationActionValues {
  plan_digest: string;
  pages_digest: string;
  chrome_digest: string;
  brand_digest: string;
  categories_digest: string;
  products_digest: string;
  page_count: string;
  photo_count: string;
}

export interface MinkStorefrontPersonalizationActionApproval {
  id: string;
  toolName: "apply_storefront_personalization";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  draftId: string;
  draftVersion: number;
  resource: {
    type: "storefront";
    id: string;
    label: string;
    dashboardPath: string;
  };
  before: MinkStorefrontPersonalizationActionValues;
  after: MinkStorefrontPersonalizationActionValues;
  /**
   * The pages the approval writes, for the card's Publish step. ★ A page a
   * storefront revamp (plan version 2) creates has no id until Apply writes
   * it, so its `id` is ""; the revamp card publishes from the revamp's own
   * apply snapshot instead.
   */
  pages: Array<{ id: string; slug: string; title: string }>;
  /** Whether the header, footer or look changed, so Publish includes them. */
  chromeChanged: boolean;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkStorefrontPersonalizationActionResult {
  approval: MinkStorefrontPersonalizationActionApproval;
  auditId: string;
  repeated: boolean;
}
