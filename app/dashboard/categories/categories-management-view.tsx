"use client";

import { ResponsiveTable } from "@/app/dashboard/components/responsive-table";

import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import Link from "next/link";
import {
  FolderTree,
  ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
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
import { deleteCategory } from "@/app/actions/category-actions";
import {
  hasMinkPrefillParam,
  takeMinkPrefill,
  MINK_PREFILL_PARAM,
  type MinkCategoryPrefill,
} from "@/lib/mink/form-prefill";
import { ImportExportMenu } from "@/app/dashboard/components/import-export-menu";
import { STORE_NOTICES_HREF } from "@/app/dashboard/components/unread-counts-context";
import { ITEM, itemBlockedBanner } from "@/lib/moderation/copy";
import { CategoryEditorDialog } from "./category-editor-dialog";
import type { Category } from "./page";

type Props = {
  categories: Category[];
  canManage?: boolean;
  /**
   * Collections StoreMink blocked and told the store about, collection id to
   * block id (takedown design 7.3). A block kept from the store is not here
   * (D21), so it shows nothing.
   */
  blockedByStoreMink?: Record<string, string>;
  /** Whether this admin may open Settings, Notices from StoreMink. */
  canSeeNotices?: boolean;
};

/** Where "See why" goes for a blocked collection: its notice. */
function noticeHref(blockId: string): string {
  return `${STORE_NOTICES_HREF}/${blockId}`;
}

/**
 * Fields Mink filled in for a new category, read once and cleared.
 *
 * ★ Only on `/dashboard/categories?prefill=mink`, and only on the client (the
 * lazy initialiser runs on the server too, where there is no window). The
 * product editor follows the same shape.
 */
function minkPrefilledCategory(): MinkCategoryPrefill | null {
  if (typeof window === "undefined") return null;
  if (!hasMinkPrefillParam(window.location.search)) return null;
  return takeMinkPrefill("category");
}

const subscribeToNothing = () => () => {};

export function CategoriesManagementView({
  categories,
  canManage = true,
  blockedByStoreMink,
  canSeeNotices = false,
}: Props) {
  const router = useRouter();
  // The notice a blocked collection's "See why" opens, or null when the
  // collection is not blocked (or the store was not told).
  const blockIdOf = (categoryId: string): string | null =>
    blockedByStoreMink?.[categoryId] ?? null;
  const blockedCategories = categories.filter((c) => blockIdOf(c.id) !== null);
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  // ★ A waiting prefill opens the editor in "new category" mode, but only
  // once hydrated: the server rendered no dialog, and opening one during
  // hydration would make React throw the page away and draw it again.
  const [minkPrefill, setMinkPrefill] = useState(minkPrefilledCategory);
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const minkOpen = hydrated && minkPrefill !== null;
  useEffect(() => {
    if (!minkPrefill) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(MINK_PREFILL_PARAM)) return;
    url.searchParams.delete(MINK_PREFILL_PARAM);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [minkPrefill]);

  const filtered = useMemo(() => {
    if (!search.trim()) return categories;
    const q = search.toLowerCase();
    return categories.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q),
    );
  }, [categories, search]);

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteCategory(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Category deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  const openEditor = (category?: Category) => {
    setEditing(category ?? null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(null);
    setMinkPrefill(null);
  };

  const handleSaved = () => {
    closeEditor();
    router.refresh();
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Categories</h1>
          <p>Organize your storefront catalog into categories</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ImportExportMenu resource="categories" canImport={canManage} />
          {canManage && (
            <button
              className="dash-btn dash-btn-primary"
              onClick={() => openEditor()}
            >
              <Plus className="h-4 w-4" />
              New category
            </button>
          )}
        </div>
      </header>

      {blockedCategories.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {blockedCategories.map((c) => {
            const blockId = blockIdOf(c.id);
            return (
              <div
                key={c.id}
                role="status"
                data-testid="category-blocked-banner"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--dash-radius)] border border-[var(--dash-red)]/30 bg-[var(--dash-red-soft)] px-4 py-3"
              >
                <ShieldAlert
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-[var(--dash-red)]"
                />
                <div className="min-w-0 flex-1 basis-56 text-[13px] text-[var(--dash-text)]">
                  <p className="font-semibold">{c.name}</p>
                  <p>
                    <span className="font-semibold">{ITEM.blocked}.</span>{" "}
                    {itemBlockedBanner("collection")}
                  </p>
                </div>
                {canSeeNotices && blockId && (
                  <Link
                    href={noticeHref(blockId)}
                    className="dash-btn dash-btn-ghost dash-btn-sm shrink-0 pointer-coarse:min-h-11"
                  >
                    {ITEM.seeWhy}
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="dash-card flex flex-col">
        <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)] mb-0 flex flex-col gap-4">
          <div className="dash-toolbar-actions w-full flex justify-between">
            <div></div>
            <label className="dash-search-bar">
              <Search className="h-4 w-4 shrink-0 opacity-50" />
              <input
                type="text"
                placeholder="Search categories"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <FolderTree className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search ? "No categories match your search" : "No categories yet"}
            </div>
            <p className="dash-empty-text">
              {search
                ? "Try a different search term."
                : "Create your first category to start organizing products."}
            </p>
            {!search && canManage && (
              <button
                className="dash-btn dash-btn-primary"
                onClick={() => openEditor()}
              >
                <Plus className="h-4 w-4" />
                New category
              </button>
            )}
          </div>
        ) : (
          <ResponsiveTable className="dash-table dash-table-wide">
            <thead>
              <tr>
                <th className="w-14">Image</th>
                <th>Name</th>
                <th>Products</th>
                <th>Order</th>
                <th>Status</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.image_url ? (
                      <div className="dash-thumb">
                        <Image
                          src={c.image_url}
                          alt={c.name}
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
                    <div className="dash-cell-title">{c.name}</div>
                    <div className="dash-cell-sub mono">/{c.slug}</div>
                  </td>
                  <td className="text-muted">
                    {c.product_count ?? 0}{" "}
                    {c.product_count === 1 ? "product" : "products"}
                  </td>
                  <td className="text-dim font-mono-dash">{c.sort_order}</td>
                  <td>
                    {blockIdOf(c.id) ? (
                      // A collection StoreMink blocked is hidden whatever its
                      // own status says (takedown design 7.3).
                      <span className="dash-badge dash-badge-storemink">
                        {ITEM.blocked}
                      </span>
                    ) : (
                      <span
                        className={`dash-badge ${
                          c.status === "active"
                            ? "dash-badge-green"
                            : "dash-badge-grey"
                        }`}
                      >
                        {c.status === "active" ? "Active" : "Hidden"}
                      </span>
                    )}
                  </td>
                  {canManage && (
                    <td className="dash-col-actions">
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
                            onClick={() => openEditor(c)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          {(() => {
                            const blockId = blockIdOf(c.id);
                            if (!blockId || !canSeeNotices) return null;
                            return (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => router.push(noticeHref(blockId))}
                              >
                                <ShieldAlert className="mr-2 h-4 w-4" />
                                {ITEM.seeWhyItIsBlocked}
                              </DropdownMenuItem>
                            );
                          })()}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => setDeleteTarget(c)}
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
      </div>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete category</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.name}&rdquo;? Its products stay and
              become uncategorized.
            </DialogDescription>
          </DialogHeader>
          {(deleteTarget?.product_count ?? 0) > 0 && (
            <div className="py-2">
              <p className="text-sm text-[var(--dash-amber)]">
                {deleteTarget?.product_count} product
                {deleteTarget?.product_count === 1 ? "" : "s"} will become
                uncategorized.
              </p>
            </div>
          )}
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

      <CategoryEditorDialog
        open={editorOpen || minkOpen}
        category={editing}
        prefill={minkPrefill}
        onClose={closeEditor}
        onSaved={handleSaved}
        blockedByStoreMink={editing ? blockIdOf(editing.id) : null}
        canSeeNotices={canSeeNotices}
      />
    </div>
  );
}
