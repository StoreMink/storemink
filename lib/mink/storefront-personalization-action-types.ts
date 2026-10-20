/**
 * The approval and result shapes for applying one personalised storefront.
 *
 * ★ THE APPROVAL CARRIES DIGESTS, NOT THE PLAN. The plan holds whole section
 *   lists and lives on the draft row; copying it onto the approval would store
 *   it twice more. Execution re-reads the plan and every target and refuses
 *   unless each hashes to what was approved (9B's rule).
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
  /** The pages the approval writes, for the card's Publish step. */
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
