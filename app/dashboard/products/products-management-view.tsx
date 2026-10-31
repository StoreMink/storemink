"use client";

import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import { canOptimizeImage } from "@/lib/media/image-hosts";
import {
  Ban,
  Eye,
  ImageIcon,
  Lightbulb,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  deleteProduct,
  toggleProductPublish,
  bulkToggleProductPublish,
  bulkSetProductFeatured,
  bulkDeleteProducts,
} from "@/app/actions/product-actions";
import { useRowSelection } from "@/app/dashboard/lib/use-row-selection";
import {
  BulkActionBar,
  RowCheckbox,
  SelectAllCheckbox,
} from "@/app/dashboard/components/bulk-actions";
import { ListPagination } from "@/app/dashboard/components/list-pagination";
import { ImportExportMenu } from "@/app/dashboard/components/import-export-menu";
import { effectivePricing, formatPrice } from "@/lib/pricing";
import { ITEM } from "@/lib/moderation/copy";
import { STORE_NOTICES_HREF } from "@/app/dashboard/components/unread-counts-context";
import type {
  ProductListItem,
  CategoryOption,
  ProductFilter,
  ProductCounts,
} from "./page";

type Props = {
  products: ProductListItem[];
  categories: CategoryOption[];
  canManage?: boolean;
  counts: ProductCounts;
  total: number;
  page: number;
  pageSize: number;
  query: string;
  filter: ProductFilter;
  categoryFilter: string;
  canUseGrossMargin?: boolean;
  missingCostCount?: number;
  canCreateProduct?: boolean;
  productLimit?: number | null;
  /**
   * Products StoreMink blocked and told the store about, product id to block
   * id (takedown design 7.3). A block kept from the store is not in here, so
   * the product shows nothing (D21).
   */
  blockedByStoreMink?: Record<string, string>;
  /** Whether this admin may open Settings, Notices from StoreMink. */
  canSeeNotices?: boolean;
};

/** Where "See why" goes for a blocked product: its notice. */
function noticeHref(blockId: string): string {
  return `${STORE_NOTICES_HREF}/${blockId}`;
}

export function ProductsManagementView({
  products,
  categories,
  canManage = true,
  counts,
  total,
  page,
  pageSize,
  query,
  filter,
  categoryFilter,
  canUseGrossMargin = false,
  missingCostCount = 0,
  canCreateProduct = true,
  productLimit = null,
  blockedByStoreMink,
  canSeeNotices = false,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  // The notice a blocked product's "See why" opens, or null when the product
  // has no block the store was told about.
  const blockIdOf = (productId: string): string | null =>
    blockedByStoreMink?.[productId] ?? null;
  const [isPending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query);
  const [deleteTarget, setDeleteTarget] = useState<ProductListItem | null>(
    null,
  );

  const hrefFor = (next: {
    q?: string;
    filter?: ProductFilter;
    category?: string;
    page?: number;
  }): string => {
    const q = (next.q ?? query).trim();
    const f = next.filter ?? filter;
    const cat = next.category ?? categoryFilter;
    const changedFacet =
      next.q !== undefined ||
      next.filter !== undefined ||
      next.category !== undefined;
    const p = next.page ?? (changedFacet ? 1 : page);

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (f !== "all") params.set("filter", f);
    if (cat !== "all") params.set("category", cat);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const go = (next: Parameters<typeof hrefFor>[0]) =>
    startNavigation(() => router.push(hrefFor(next)));

  useEffect(() => {
    if (search.trim() === query.trim()) return;
    const handle = setTimeout(() => {
      startNavigation(() => router.push(hrefFor({ q: search })));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // ── Bulk selection (scoped to the current page) ────────────
  const visibleIds = useMemo(() => products.map((p) => p.id), [products]);
  const selection = useRowSelection(visibleIds);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Publishing or unpublishing a blocked product changes nothing a shopper
  // sees (design 7.3), so the bulk buttons wait while one is selected.
  const selectionBlocked = selection.selectedIds.some(
    (id) => blockIdOf(id) !== null,
  );

  const runBulk = (
    action: () => Promise<{
      error?: string;
      success?: boolean;
      data?: Record<string, unknown>;
    }>,
    successMsg: string,
  ) => {
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        toast.error(result.error);
      } else {
        const deleted = Number(result.data?.deleted ?? 0);
        const skipped = Number(result.data?.skipped ?? 0);
        if (skipped > 0) {
          toast.warning(
            `Deleted ${deleted} product${deleted === 1 ? "" : "s"}. ${skipped} ${skipped === 1 ? "has" : "have"} orders and ${skipped === 1 ? "was" : "were"} kept - unpublish ${skipped === 1 ? "it" : "them"} instead.`,
          );
        } else {
          toast.success(successMsg);
        }
        selection.clear();
        setBulkDeleteOpen(false);
        router.refresh();
      }
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteProduct(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Product deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  const handleTogglePublish = (product: ProductListItem) => {
    startTransition(async () => {
      const publish = product.status !== "published";
      const result = await toggleProductPublish(product.id, publish);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(publish ? "Product published" : "Product unpublished");
        router.refresh();
      }
    });
  };

  // Both create and edit are full-page, shareable routes so a teammate can be
  // sent a direct link (create = /dashboard/products/new, edit = /[id]).
  const openCreate = () => router.push("/dashboard/products/new");
  const openEdit = (product: ProductListItem) =>
    router.push(`/dashboard/products/${product.id}`);

  const tabs: { key: ProductFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "published", label: "Published", count: counts.published },
    { key: "drafts", label: "Drafts", count: counts.drafts },
    { key: "featured", label: "Featured", count: counts.featured },
  ];

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Products</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Exports carry the list's own filters, so "export what I'm
              looking at" is what actually happens. */}
          <ImportExportMenu
            resource="products"
            canImport={canManage}
            filters={{
              status:
                filter === "drafts"
                  ? "draft"
                  : filter === "published"
                    ? "published"
                    : undefined,
            }}
          />
          {canManage && (
            <button
              className="dash-btn dash-btn-primary"
              onClick={openCreate}
              disabled={!canCreateProduct}
              title={
                canCreateProduct
                  ? undefined
                  : `Your plan includes ${productLimit} products`
              }
            >
              <Plus className="h-4 w-4" />
              New product
            </button>
          )}
        </div>
      </header>

      {canManage && !canCreateProduct && productLimit !== null ? (
        <div className="dash-card mb-3.5 flex items-center justify-between gap-3 px-4 py-3.5 text-[13px]">
          <span>
            Your plan includes {productLimit} products. Upgrade to add another.
          </span>
          <Link
            href="/dashboard/plans"
            className="dash-btn dash-btn-primary shrink-0"
          >
            View plans
          </Link>
        </div>
      ) : null}

      {categories.length === 0 && (
        <div className="dash-card mb-3.5 flex items-center gap-2 px-4 py-3.5 text-[13px]">
          <Lightbulb className="h-4 w-4 shrink-0 text-[var(--dash-amber)]" />
          <span>
            No categories yet. To group products on the storefront,{" "}
            <Link
              href="/dashboard/categories"
              className="font-semibold text-[var(--dash-accent)]"
            >
              create a category
            </Link>
            .
          </span>
        </div>
      )}

      {canUseGrossMargin && missingCostCount > 0 ? (
        <div className="dash-card mb-3.5 flex items-center gap-2 px-4 py-3.5 text-[13px]">
          <Lightbulb className="h-4 w-4 shrink-0 text-[var(--dash-amber)]" />
          <span>
            {missingCostCount}{" "}
            {missingCostCount === 1 ? "product needs" : "products need"} a cost
            in the <strong>Pricing</strong> tab for gross-margin reporting.
          </span>
        </div>
      ) : null}

      <div className="dash-card flex flex-col" style={{ flex: "1 1 auto" }}>
        {/* Toolbar: Tabs + Category filter + Search - Now INSIDE the card */}
        <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)] mb-0 flex flex-col gap-4">
          <div className="dash-filter-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                className={`dash-filter-tab${filter === tab.key ? " active" : ""}`}
                onClick={() => go({ filter: tab.key })}
              >
                {tab.label}
                <span className="dash-tab-count">{tab.count}</span>
              </button>
            ))}
          </div>

          <div className="dash-toolbar-actions w-full flex justify-between">
            <div className="flex items-center gap-2">
              <select
                value={categoryFilter}
                onChange={(e) => go({ category: e.target.value })}
                className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              >
                <option value="all">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="uncategorized">Uncategorized</option>
              </select>
            </div>

            <label className="dash-search-bar">
              <Search className="h-4 w-4 shrink-0 opacity-50" />
              <input
                type="text"
                placeholder="Search products"
                aria-label="Search products"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
        </div>

        {products.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <Package className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search || filter !== "all" || categoryFilter !== "all"
                ? "No products match your filters"
                : "No products yet"}
            </div>
            <p className="dash-empty-text">
              {search || filter !== "all" || categoryFilter !== "all"
                ? "Try adjusting your filters."
                : "Add your first product to get started."}
            </p>
            {!search &&
              filter === "all" &&
              categoryFilter === "all" &&
              canManage &&
              canCreateProduct && (
                <button
                  className="dash-btn dash-btn-primary"
                  onClick={openCreate}
                >
                  <Plus className="h-4 w-4" />
                  New product
                </button>
              )}
          </div>
        ) : (
          <ResponsiveTable className="dash-table dash-table-wide">
            <thead>
              <tr>
                {canManage && (
                  <th className="dash-checkbox-cell">
                    <SelectAllCheckbox
                      checked={selection.allSelected}
                      indeterminate={selection.someSelected}
                      onChange={selection.toggleAll}
                    />
                  </th>
                )}
                <th className="w-14">Image</th>
                <th>Name</th>
                <th>Category</th>
                <th>Price</th>
                <th>Variants</th>
                <th>Status</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr
                  key={p.id}
                  onClick={canManage ? () => openEdit(p) : undefined}
                  onMouseEnter={
                    canManage
                      ? () => router.prefetch(`/dashboard/products/${p.id}`)
                      : undefined
                  }
                  className={`${canManage ? "cursor-pointer" : ""}${
                    selection.isSelected(p.id) ? " is-selected" : ""
                  }`}
                  title={canManage ? "Edit product" : undefined}
                >
                  {canManage && (
                    <td
                      className="dash-col-actions dash-checkbox-cell"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <RowCheckbox
                        checked={selection.isSelected(p.id)}
                        onToggle={() => selection.toggle(p.id)}
                        label={`Select ${p.name}`}
                      />
                    </td>
                  )}
                  <td>
                    {p.image_url ? (
                      <div className="dash-thumb">
                        <Image
                          src={p.image_url}
                          unoptimized={!canOptimizeImage(p.image_url)}
                          alt={p.name}
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <div className="dash-thumb dash-thumb-empty">
                        <ImageIcon className="h-4 w-4" />
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="dash-cell-title inline-flex items-center gap-1.5">
                      {p.name}
                      {p.featured && (
                        <Star
                          className="h-3.5 w-3.5 fill-[var(--dash-amber)] text-[var(--dash-amber)]"
                          aria-label="Featured"
                        />
                      )}
                    </div>
                    <div className="dash-cell-sub mono">/{p.slug}</div>
                  </td>
                  <td>
                    {p.category ? (
                      <div className="dash-chip-row">
                        <span className="dash-chip">{p.category.name}</span>
                      </div>
                    ) : (
                      <span className="text-dim">Uncategorized</span>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const pricing = effectivePricing(p);
                      return (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {pricing.hasVariants && (
                            <span className="text-dim text-xs">from</span>
                          )}
                          <span className="dash-cell-title mono">
                            {formatPrice(pricing.selling)}
                          </span>
                          {pricing.discount > 0 && (
                            <>
                              <span className="dash-cell-sub mono line-through">
                                {formatPrice(pricing.base)}
                              </span>
                              <span className="dash-badge dash-badge-green">
                                -{pricing.discount}%
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    {p.variants.length > 0 ? (
                      <span className="dash-badge dash-badge-grey">
                        {p.variants.length}{" "}
                        {p.variants.length === 1 ? "variant" : "variants"}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>
                    {blockIdOf(p.id) ? (
                      // A product StoreMink blocked is hidden whatever its
                      // own status says (takedown design 7.3).
                      <span className="dash-badge dash-badge-storemink">
                        {ITEM.blocked}
                      </span>
                    ) : (
                      <span
                        className={`dash-badge ${
                          p.status === "published"
                            ? "dash-badge-green"
                            : "dash-badge-amber"
                        }`}
                      >
                        {p.status === "published" ? "Published" : "Draft"}
                      </span>
                    )}
                  </td>
                  {canManage && (
                    <td
                      className="dash-col-actions"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger className="dash-row-menu">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[180px]"
                        >
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => openEdit(p)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          {blockIdOf(p.id) ? (
                            // Publishing or unpublishing changes nothing a
                            // shopper sees while StoreMink's block stands
                            // (design 7.3). Editing and deleting stay open.
                            <DropdownMenuItem disabled>
                              <Ban className="mr-2 h-4 w-4" />
                              {ITEM.blocked}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onClick={() => handleTogglePublish(p)}
                              disabled={isPending}
                            >
                              {p.status === "published" ? (
                                <>
                                  <Undo2 className="mr-2 h-4 w-4" />
                                  Unpublish
                                </>
                              ) : (
                                <>
                                  <Send className="mr-2 h-4 w-4" />
                                  Publish
                                </>
                              )}
                            </DropdownMenuItem>
                          )}
                          {(() => {
                            const blockId = blockIdOf(p.id);
                            if (!blockId) {
                              return (
                                <DropdownMenuItem
                                  className="cursor-pointer"
                                  onClick={() =>
                                    window.open(`/shop/${p.slug}`, "_blank")
                                  }
                                >
                                  <Eye className="mr-2 h-4 w-4" />
                                  Preview
                                </DropdownMenuItem>
                              );
                            }
                            // A blocked product's page is not found for
                            // shoppers, so Preview gives way to the notice.
                            return canSeeNotices ? (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => router.push(noticeHref(blockId))}
                              >
                                <ShieldAlert className="mr-2 h-4 w-4" />
                                {ITEM.seeWhyItIsBlocked}
                              </DropdownMenuItem>
                            ) : null;
                          })()}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => setDeleteTarget(p)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}

        <ListPagination
          page={page}
          total={total}
          pageSize={pageSize}
          busy={navigating}
          onPage={(p) => go({ page: p })}
        />
      </div>

      {/* Bulk action bar (appears while rows are selected) */}
      {canManage && (
        <BulkActionBar
          count={selection.count}
          onClear={selection.clear}
          busy={isPending}
        >
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending || selectionBlocked}
            onClick={() =>
              runBulk(
                () => bulkToggleProductPublish(selection.selectedIds, true),
                "Selected products published",
              )
            }
          >
            <Send className="h-4 w-4" />
            <BulkLabel blocked={selectionBlocked}>Publish</BulkLabel>
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending || selectionBlocked}
            onClick={() =>
              runBulk(
                () => bulkToggleProductPublish(selection.selectedIds, false),
                "Selected products unpublished",
              )
            }
          >
            <Undo2 className="h-4 w-4" />
            <BulkLabel blocked={selectionBlocked}>Unpublish</BulkLabel>
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetProductFeatured(selection.selectedIds, true),
                "Selected products featured",
              )
            }
          >
            <Star className="h-4 w-4" />
            Feature
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetProductFeatured(selection.selectedIds, false),
                "Selected products unfeatured",
              )
            }
          >
            <Star className="h-4 w-4" />
            Unfeature
          </button>
          <button
            type="button"
            className="dash-bulk-btn dash-bulk-btn-danger"
            disabled={isPending}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </BulkActionBar>
      )}

      {/* Bulk delete confirmation */}
      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !open && setBulkDeleteOpen(false)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              Delete {selection.count} product
              {selection.count === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              This can&rsquo;t be undone. Products with orders are kept;
              unpublish those instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() =>
                runBulk(
                  () => bulkDeleteProducts(selection.selectedIds),
                  `Deleted ${selection.count} product${selection.count === 1 ? "" : "s"}`,
                )
              }
            >
              {isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete product</DialogTitle>
            <DialogDescription>
              &ldquo;{deleteTarget?.name}&rdquo; and its variants will be
              deleted for good. A product with orders can&rsquo;t be deleted;
              unpublish it instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A bulk Publish or Unpublish label, with the reason it waits written under
 * it when a selected product is blocked by StoreMink (never a tooltip:
 * tooltips do not open on touch).
 */
function BulkLabel({
  blocked,
  children,
}: {
  blocked: boolean;
  children: string;
}) {
  if (!blocked) return <>{children}</>;
  return (
    <span className="flex flex-col items-start leading-tight">
      <span>{children}</span>
      <span className="text-[11px] font-medium">{ITEM.blocked}</span>
    </span>
  );
}
