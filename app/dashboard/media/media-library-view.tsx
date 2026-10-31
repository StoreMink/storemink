"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload,
  UploadCloud,
  Copy,
  Check,
  Trash2,
  X,
  ImageIcon,
  Loader2,
  ExternalLink,
  Package,
  Sparkles,
  AlertTriangle,
  ShieldAlert,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ListPagination } from "@/app/dashboard/components/list-pagination";
import {
  uploadMediaAsset,
  deleteMediaAsset,
} from "@/app/actions/media-actions";
import {
  usedByLabel,
  type MediaAsset,
  type ProductImageItem,
  type ProductRef,
} from "@/lib/media/library-types";
import { mediaSourceLabel } from "@/lib/media/sources";
import { canOptimizeImage } from "@/lib/media/image-hosts";
import { STORE_NOTICES_HREF } from "@/app/dashboard/components/unread-counts-context";
import { ITEM } from "@/lib/moderation/copy";

const MAX_BYTES = 5 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A Library row with the products that already use it. */
export type LibraryTile = MediaAsset & { products: ProductRef[] };

/** What the view modal shows: a Library image or a product photo. */
type Viewing =
  | { kind: "library"; asset: LibraryTile }
  | { kind: "product"; image: ProductImageItem };

type Props = {
  tab: "library" | "products";
  assets: LibraryTile[];
  productImages: ProductImageItem[];
  libraryTotal: number;
  productTotal: number;
  canSeeProducts: boolean;
  loadError: boolean;
  page: number;
  pageSize: number;
  /**
   * Files StoreMink blocked and told the store about, the address a tile
   * shows to block id (takedown design 7.3). A block kept from the store is
   * not here (D21), so it shows nothing.
   */
  blockedByStoreMink?: Record<string, string>;
  /** Whether this admin may open Settings, Notices from StoreMink. */
  canSeeNotices?: boolean;
};

/** Where "See why" goes for a blocked file: its notice. */
function noticeHref(blockId: string): string {
  return `${STORE_NOTICES_HREF}/${blockId}`;
}

export function MediaLibraryView({
  tab,
  assets,
  productImages,
  libraryTotal,
  productTotal,
  canSeeProducts,
  loadError,
  page,
  pageSize,
  blockedByStoreMink,
  canSeeNotices = false,
}: Props) {
  const router = useRouter();
  // The notice a blocked file's "See why" opens, or null when the file is
  // not blocked (or the store was not told).
  const blockIdOf = (url: string): string | null =>
    (url && blockedByStoreMink?.[url]) || null;
  const pathname = usePathname();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [staged, setStaged] = useState<File | null>(null);
  const [stagedPreview, setStagedPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, startUpload] = useTransition();
  const [pending, startAction] = useTransition();
  const [navigating, startNav] = useTransition();

  const [viewing, setViewing] = useState<Viewing | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryTile | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const total = tab === "library" ? libraryTotal : productTotal;

  // Release the object URL backing the staged preview.
  useEffect(() => {
    return () => {
      if (stagedPreview) URL.revokeObjectURL(stagedPreview);
    };
  }, [stagedPreview]);

  function stage(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Image must be 5 MB or smaller.");
      return;
    }
    setStagedPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setStaged(file);
  }

  function clearStaged() {
    setStaged(null);
    setStagedPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function confirmUpload() {
    if (!staged) return;
    const fd = new FormData();
    fd.append("file", staged);
    startUpload(async () => {
      const res = await uploadMediaAsset(fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Uploaded to your library");
      clearStaged();
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    startAction(async () => {
      const res = await deleteMediaAsset(id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Deleted");
      setDeleteTarget(null);
      setViewing((v) =>
        v?.kind === "library" && v.asset.id === id ? null : v,
      );
      router.refresh();
    });
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl((c) => (c === url ? null : c)), 1800);
      toast.success("URL copied");
    } catch {
      toast.error("Couldn't copy - select the URL and copy it manually.");
    }
  }

  const navigate = (nextTab: "library" | "products", p: number) => {
    const params = new URLSearchParams();
    if (nextTab === "products") params.set("tab", "products");
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    startNav(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  };
  const goToPage = (p: number) => navigate(tab, p);

  const viewingUrl =
    viewing?.kind === "library"
      ? viewing.asset.url
      : viewing?.kind === "product"
        ? viewing.image.url
        : "";
  const viewingBlockId = blockIdOf(viewingUrl);
  const viewingProducts =
    viewing?.kind === "library"
      ? viewing.asset.products
      : viewing?.kind === "product"
        ? viewing.image.products
        : [];

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Media Library</h1>
          <p>
            {canSeeProducts
              ? "Images you uploaded, pictures Mink AI made, and every photo your products use"
              : "Images you uploaded and pictures Mink AI made"}
          </p>
        </div>
        {tab === "library" && (
          <button
            type="button"
            className="dash-btn dash-btn-primary shrink-0"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="h-4 w-4" />
            Upload
          </button>
        )}
      </header>

      {canSeeProducts && (
        <div className="dash-filter-tabs mb-3.5 w-fit" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "library"}
            className={`dash-filter-tab ${tab === "library" ? "active" : ""}`}
            onClick={() => tab !== "library" && navigate("library", 1)}
            disabled={navigating}
          >
            <ImageIcon className="h-3.5 w-3.5" />
            Library
            <span className="dash-tab-count">{libraryTotal}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "products"}
            className={`dash-filter-tab ${tab === "products" ? "active" : ""}`}
            onClick={() => tab !== "products" && navigate("products", 1)}
            disabled={navigating}
          >
            <Package className="h-3.5 w-3.5" />
            Product images
            <span className="dash-tab-count">{productTotal}</span>
          </button>
        </div>
      )}

      {loadError && (
        <div
          role="alert"
          className="mb-3.5 flex items-start gap-2 rounded-[var(--dash-radius-sm)] border border-[var(--dash-amber)]/40 bg-[var(--dash-amber-soft)] px-3 py-2 text-[13px] text-[var(--dash-text)]"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-amber)]" />
          Couldn&apos;t load these images. Refresh the page to try again.
        </div>
      )}

      {/* Hidden input drives both the header button and the dropzone. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) stage(f);
        }}
      />

      {/* Upload / confirm-before-upload zone */}
      {tab === "library" && (
        <div className="dash-card mb-3.5">
          <div className="dash-card-body">
            {staged && stagedPreview ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative h-40 w-full shrink-0 overflow-hidden rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)] sm:w-56">
                  {/* Local blob preview — next/image can't take a blob: URL. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={stagedPreview}
                    alt="Preview"
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-[var(--dash-text)]">
                    {staged.name}
                  </div>
                  <div className="text-[12px] text-[var(--dash-text-3)]">
                    {formatSize(staged.size)} · optimized to WebP on upload
                  </div>
                  <p className="mt-1 text-[12px] text-[var(--dash-text-3)]">
                    Upload this image to your library?
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={confirmUpload}
                      disabled={uploading}
                      className="gap-1.5"
                    >
                      {uploading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {uploading ? "Uploading…" : "Upload"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={clearStaged}
                      disabled={uploading}
                      className="gap-1.5"
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) stage(f);
                }}
                className={`flex h-40 cursor-pointer flex-col items-center justify-center rounded-[var(--dash-radius-sm)] border-2 border-dashed text-center transition-colors ${
                  dragOver
                    ? "border-[var(--dash-accent)] bg-[var(--dash-accent)]/5"
                    : "border-[var(--dash-border)] hover:bg-[var(--dash-surface-2)]"
                }`}
              >
                <UploadCloud className="mb-2 h-7 w-7 text-[var(--dash-text-3)]" />
                <p className="text-[13px] font-medium text-[var(--dash-text)]">
                  <span className="text-[var(--dash-accent)]">
                    Click to upload
                  </span>{" "}
                  or drag and drop
                </p>
                <p className="text-[12px] text-[var(--dash-text-3)]">
                  PNG, JPG, WEBP, SVG, GIF (max 5 MB)
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Grid: Library images, or the photos products use */}
      <div className="dash-card flex flex-col" style={{ flex: "1 1 auto" }}>
        <div className="dash-card-header">
          <div className="dash-card-title">
            {tab === "library" ? "Library" : "Product images"}
          </div>
          <span className="text-[12px] text-[var(--dash-text-3)]">
            {total} {total === 1 ? "item" : "items"}
          </span>
        </div>
        <div className="dash-card-body">
          {tab === "products" && (
            <p className="mb-3 text-[12.5px] text-[var(--dash-text-3)]">
              Every photo your products use. To change or remove one, open the
              product.
            </p>
          )}
          {tab === "library" && assets.length === 0 ? (
            <EmptyGrid text="No media yet. Upload your first image above." />
          ) : tab === "products" && productImages.length === 0 ? (
            <EmptyGrid text="No product photos yet. Add photos to a product and they appear here." />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {tab === "library"
                ? assets.map((asset) => {
                    const label = mediaSourceLabel(asset.source);
                    const blockId = blockIdOf(asset.url);
                    return (
                      <div
                        key={asset.id}
                        className="group overflow-hidden rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)]"
                      >
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() =>
                              setViewing({ kind: "library", asset })
                            }
                            className="relative block aspect-square w-full"
                            title={asset.filename || "View"}
                          >
                            <Image
                              src={asset.url}
                              unoptimized={!canOptimizeImage(asset.url)}
                              alt={asset.filename || "Media"}
                              fill
                              sizes="(max-width:640px) 50vw,(max-width:1024px) 33vw,200px"
                              className="object-cover"
                            />
                          </button>
                          <TileBadges label={label} products={asset.products} />
                          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-end gap-1 p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => copyUrl(asset.url)}
                              className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur hover:bg-black/70"
                              title="Copy URL"
                            >
                              {copiedUrl === asset.url ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(asset)}
                              className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur hover:bg-[var(--dash-red)]"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                        <BlockedStrip
                          blockId={blockId}
                          canSeeNotices={canSeeNotices}
                        />
                      </div>
                    );
                  })
                : productImages.map((image) => (
                    <div
                      key={image.url}
                      className="overflow-hidden rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)]"
                    >
                      <button
                        type="button"
                        onClick={() => setViewing({ kind: "product", image })}
                        className="relative block aspect-square w-full"
                        title="View"
                      >
                        <Image
                          src={image.url}
                          unoptimized={!canOptimizeImage(image.url)}
                          alt={usedByLabel(image.products) || "Product photo"}
                          fill
                          sizes="(max-width:640px) 50vw,(max-width:1024px) 33vw,200px"
                          className="object-cover"
                        />
                      </button>
                      <div className="truncate border-t border-[var(--dash-border)] bg-[var(--dash-surface)] px-2 py-1.5 text-[12px] text-[var(--dash-text-2)]">
                        {usedByLabel(image.products)}
                      </div>
                      <BlockedStrip
                        blockId={blockIdOf(image.url)}
                        canSeeNotices={canSeeNotices}
                      />
                    </div>
                  ))}
            </div>
          )}
        </div>
        <ListPagination
          page={page}
          total={total}
          pageSize={pageSize}
          busy={navigating}
          onPage={goToPage}
        />
      </div>

      {/* View modal */}
      <Dialog
        open={viewing !== null}
        onOpenChange={(o) => !o && setViewing(null)}
      >
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle className="truncate">
              {viewing?.kind === "library"
                ? viewing.asset.filename || "Media"
                : "Product photo"}
            </DialogTitle>
            <DialogDescription>
              {viewing?.kind === "library"
                ? [
                    formatSize(viewing.asset.size_bytes),
                    viewing.asset.content_type || "image",
                    mediaSourceLabel(viewing.asset.source),
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : viewing?.kind === "product"
                  ? "Change or remove it from the product that uses it."
                  : ""}
            </DialogDescription>
          </DialogHeader>
          {viewing && (
            <>
              {viewingBlockId && (
                <div
                  role="status"
                  data-testid="media-blocked-status"
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--dash-radius-sm)] border border-[var(--dash-red)]/30 bg-[var(--dash-red-soft)] px-3 py-2"
                >
                  <ShieldAlert
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-[var(--dash-red)]"
                  />
                  <span className="dash-badge dash-badge-storemink">
                    {ITEM.blocked}
                  </span>
                  {canSeeNotices && (
                    <Link
                      href={noticeHref(viewingBlockId)}
                      className="dash-btn dash-btn-ghost dash-btn-sm ml-auto shrink-0 pointer-coarse:min-h-11"
                    >
                      {ITEM.seeWhyItIsBlocked}
                    </Link>
                  )}
                </div>
              )}
              <div className="relative flex max-h-[50vh] min-h-[220px] items-center justify-center overflow-hidden rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)]">
                <Image
                  src={viewingUrl}
                  unoptimized={!canOptimizeImage(viewingUrl)}
                  alt={
                    viewing.kind === "library"
                      ? viewing.asset.filename || "Media"
                      : "Product photo"
                  }
                  width={1200}
                  height={800}
                  className="max-h-[50vh] w-auto object-contain"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={viewingUrl}
                  className="dash-input h-9 flex-1 px-2 text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => copyUrl(viewingUrl)}
                >
                  {copiedUrl === viewingUrl ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  Copy
                </Button>
              </div>
              {viewingProducts.length > 0 && (
                <UsedByList products={viewingProducts} />
              )}
            </>
          )}
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => viewingUrl && window.open(viewingUrl, "_blank")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </Button>
            {viewing?.kind === "library" && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => setDeleteTarget(viewing.asset)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && !pending && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          {deleteTarget && deleteTarget.products.length > 0 ? (
            // ★ The server refuses this delete too; saying so here first
            //   spares the merchant a button that can only fail.
            <>
              <DialogHeader>
                <DialogTitle>This image is in use</DialogTitle>
                <DialogDescription>
                  {usedByLabel(deleteTarget.products)}{" "}
                  {deleteTarget.products.length === 1 ? "uses" : "use"} this
                  image. Remove it from{" "}
                  {deleteTarget.products.length === 1
                    ? "that product"
                    : "those products"}{" "}
                  first, then delete it here.
                </DialogDescription>
              </DialogHeader>
              <UsedByList products={deleteTarget.products} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Delete this image?</DialogTitle>
                <DialogDescription>
                  &ldquo;{deleteTarget?.filename || "This image"}&rdquo; is
                  deleted for good, and anything linking to it will break.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={confirmDelete}
                  disabled={pending}
                >
                  {pending ? "Deleting…" : "Delete"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The mark under a tile StoreMink blocked (takedown design 7.3): the label
 * and, for an admin who can open Notices from StoreMink, a link to the notice.
 */
function BlockedStrip({
  blockId,
  canSeeNotices,
}: {
  blockId: string | null;
  canSeeNotices: boolean;
}) {
  if (!blockId) return null;
  return (
    <div
      data-testid="media-blocked-mark"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--dash-border)] bg-[var(--dash-surface)] px-2 py-1.5"
    >
      <span className="dash-badge dash-badge-storemink">{ITEM.blocked}</span>
      {canSeeNotices && (
        <Link
          href={noticeHref(blockId)}
          className="inline-flex items-center text-[12px] font-medium text-[var(--dash-accent)] hover:underline pointer-coarse:min-h-11"
        >
          {ITEM.seeWhy}
        </Link>
      )}
    </div>
  );
}

function EmptyGrid({ text }: { text: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-[var(--dash-radius-sm)] border border-dashed border-[var(--dash-border)] px-4 text-center text-[var(--dash-text-3)]">
      <ImageIcon className="h-6 w-6" />
      <span className="text-sm">{text}</span>
    </div>
  );
}

/** Small notes on a Library tile: who made it, and how many products use it. */
function TileBadges({
  label,
  products,
}: {
  label: string | null;
  products: ProductRef[];
}) {
  if (!label && products.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap gap-1 p-1.5">
      {label && (
        <span className="inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur">
          <Sparkles className="h-3 w-3" aria-hidden />
          {label}
        </span>
      )}
      {products.length > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur"
          title={`Used by ${usedByLabel(products)}`}
        >
          <Package className="h-3 w-3" aria-hidden />
          {products.length === 1
            ? "In 1 product"
            : `In ${products.length} products`}
        </span>
      )}
    </div>
  );
}

/** The products that use an image, each linking to its editor. */
function UsedByList({ products }: { products: ProductRef[] }) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium text-[var(--dash-text-2)]">
        Used by
      </div>
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {products.map((product) => (
          <li key={product.id}>
            <Link
              href={`/dashboard/products/${product.id}`}
              className="inline-flex items-center gap-1.5 text-[13px] text-[var(--dash-accent)] hover:underline"
            >
              <Package className="h-3.5 w-3.5" aria-hidden />
              {product.name || "Untitled product"}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
