"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ITEM, itemBlockedBanner } from "@/lib/moderation/copy";
import { STORE_NOTICES_HREF } from "@/app/dashboard/components/unread-counts-context";
import {
  ProductEditorForm,
  type ProductEditorFormHandle,
} from "./product-editor-form";
import type { Product, CategoryOption, TaxClassOption } from "./page";

// Full-page product editor (Shopify-style): a STICKY header holding the back
// arrow + title + status on the left and the Save/Cancel actions on the right,
// so saving is always one click away no matter how far the form is scrolled.
// The header owns the buttons; the form exposes its validated save via a ref
// (hideActions hides the form's own bar). Drives BOTH surfaces — editing an
// existing product (product set) and creating a new one (product null).
export function ProductEditorPanel({
  product,
  categories,
  taxClasses,
  defaultTrackInventory = false,
  canUseGrossMargin = false,
  photoSpec,
}: {
  product: Product | null;
  categories: CategoryOption[];
  taxClasses: TaxClassOption[];
  defaultTrackInventory?: boolean;
  canUseGrossMargin?: boolean;
  photoSpec?: "product" | "product_square";
}) {
  const router = useRouter();
  const formRef = useRef<ProductEditorFormHandle>(null);
  const [isPending, setIsPending] = useState(false);
  const isEditing = product !== null;
  const published = product?.status === "published";
  // StoreMink's block, set by the editor's read only for a block the store
  // was told about (takedown design 7.3; D21: an untold block shows nothing).
  const block = isEditing ? (product.blockedByStoreMink ?? null) : null;

  return (
    <div
      data-mink-resource-type={product ? "product" : undefined}
      data-mink-resource-id={product?.id}
    >
      {/* Cancel the scroll container's current padding at every breakpoint. */}
      <header className="dash-editor-header sticky z-30 mb-5 flex items-center gap-3 border-b border-[#e5e7eb] bg-[var(--dash-surface,#fff)]">
        <Link
          href="/dashboard/products"
          aria-label="Back to products"
          className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
          style={{ paddingInline: 8 }}
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1
              className="truncate text-lg font-semibold"
              style={{ color: "var(--dash-text)" }}
            >
              {product?.name || "New product"}
            </h1>
            {isEditing && block ? (
              // The product keeps the status it was saved with; the block
              // hides it whatever that says.
              <span className="dash-badge dash-badge-storemink shrink-0">
                {ITEM.blocked}
              </span>
            ) : isEditing ? (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={
                  published
                    ? {
                        background: "rgba(34, 197, 94, 0.14)",
                        color: "#15803d",
                      }
                    : {
                        background: "var(--dash-surface-2, rgba(0,0,0,0.06))",
                        color: "var(--dash-text-3)",
                      }
                }
              >
                {published ? "Published" : "Draft"}
              </span>
            ) : null}
          </div>
        </div>

        {/* Actions — always visible in the header (sticky). */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            onClick={() => router.push("/dashboard/products")}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => formRef.current?.submit()}
            disabled={isPending}
          >
            {isPending
              ? "Saving…"
              : isEditing
                ? "Save changes"
                : "Create product"}
          </Button>
          {published && product && !block && (
            <a
              href={`/shop/${product.slug}`}
              target="_blank"
              rel="noreferrer"
              className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View in store
            </a>
          )}
        </div>
      </header>

      {/* Form stays centred at a readable max width; the header above spans
          the full content area. */}
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {block ? (
          <div
            role="status"
            data-testid="product-blocked-banner"
            className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--dash-radius)] border border-[var(--dash-red)]/30 bg-[var(--dash-red-soft)] px-4 py-3"
          >
            <ShieldAlert
              className="h-5 w-5 shrink-0 text-[var(--dash-red)]"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 basis-56 text-[13px] text-[var(--dash-text)]">
              <span className="font-semibold">{ITEM.blocked}.</span>{" "}
              {itemBlockedBanner("product")}
            </p>
            {block.canSeeNotices ? (
              <Link
                href={`${STORE_NOTICES_HREF}/${block.blockId}`}
                className="dash-btn dash-btn-ghost dash-btn-sm shrink-0 pointer-coarse:min-h-11"
              >
                {ITEM.seeWhy}
              </Link>
            ) : null}
          </div>
        ) : null}
        <ProductEditorForm
          ref={formRef}
          hideActions
          onPendingChange={setIsPending}
          product={product}
          categories={categories}
          taxClasses={taxClasses}
          defaultTrackInventory={defaultTrackInventory}
          canUseGrossMargin={canUseGrossMargin}
          photoSpec={photoSpec}
          onClose={() => router.push("/dashboard/products")}
          // Edit stays on the page (refresh to show saved values); create
          // returns to the list, where the new product now appears.
          onSaved={() =>
            isEditing ? router.refresh() : router.push("/dashboard/products")
          }
        />
      </div>
    </div>
  );
}
