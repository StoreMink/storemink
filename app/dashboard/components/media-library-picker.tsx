"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  Loader2,
  Package,
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
import { getMediaPickerPage } from "@/app/actions/media-actions";
import { canOptimizeImage } from "@/lib/media/image-hosts";
import {
  usedByLabel,
  type MediaPickerItem,
  type MediaPickerTab,
} from "@/lib/media/library-types";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen URLs, in the order they were picked. */
  onSelect: (urls: string[]) => void;
  /** Pick several (a gallery) or exactly one (the primary photo). */
  multiple?: boolean;
  /** Most a multiple pick may return, e.g. the room left for a colour. */
  max?: number;
  /** Photos already in place, shown as added and not pickable again. */
  exclude?: readonly string[];
  title?: string;
};

type Loaded = {
  /** Which tab and page this answer is for. */
  key: string;
  items: MediaPickerItem[];
  total: number;
  pageSize: number;
  error?: string;
};

/**
 * "Choose from library" for the product editor: the store's Media Library
 * (uploads and pictures Mink AI made or refined) and the photos its products
 * already use, so a photo is uploaded once and reused.
 *
 * ★ IT ONLY RETURNS URLS. Whether this store may use an image is decided by the
 *   product save (`firstForeignStoreImageUrl`), and both tabs list only this
 *   store's own images, so nothing here is a boundary.
 */
/**
 * Mount it only while open (`{open && <MediaLibraryPicker … />}`): every
 * opening then starts on the first page with nothing picked.
 */
export function MediaLibraryPicker({
  open,
  onClose,
  onSelect,
  multiple = false,
  max,
  exclude = [],
  title,
}: Props) {
  const [tab, setTab] = useState<MediaPickerTab>("library");
  const [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const request = useRef(0);
  const excluded = new Set(exclude);
  const limit = multiple ? Math.max(0, max ?? Infinity) : 1;
  const key = `${tab}:${page}`;
  // Loading until the answer for exactly this tab and page has arrived; the
  // previous page stays on screen, dimmed, meanwhile.
  const loading = loaded?.key !== key;

  // Load whenever the tab or page changes. A stale answer (the merchant
  // switched tabs while it was in flight) is dropped.
  useEffect(() => {
    if (!open) return;
    const id = ++request.current;
    getMediaPickerPage({ tab, page })
      .then((res) => {
        if (id !== request.current) return;
        setLoaded({
          key: `${tab}:${page}`,
          items: res.items,
          total: res.total,
          pageSize: res.pageSize,
          error: res.error,
        });
      })
      .catch(() => {
        if (id !== request.current) return;
        setLoaded({
          key: `${tab}:${page}`,
          items: [],
          total: 0,
          pageSize: 1,
          error: "Couldn't load your images. Please try again.",
        });
      });
  }, [open, tab, page]);

  function toggle(url: string) {
    if (excluded.has(url)) return;
    setPicked((current) => {
      if (current.includes(url)) return current.filter((u) => u !== url);
      if (!multiple) return [url];
      if (current.length >= limit) return current;
      return [...current, url];
    });
  }

  function switchTab(next: MediaPickerTab) {
    if (next === tab) return;
    setTab(next);
    setPage(1);
    // Another tab's photos are not a dimmed preview of this one.
    setLoaded(null);
  }

  const totalPages = loaded
    ? Math.max(1, Math.ceil(loaded.total / Math.max(1, loaded.pageSize)))
    : 1;
  const atLimit = multiple && picked.length >= limit;
  const confirmLabel = multiple
    ? picked.length === 1
      ? "Add 1 photo"
      : `Add ${picked.length} photos`
    : "Use photo";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{title ?? "Choose from library"}</DialogTitle>
          <DialogDescription>
            {multiple
              ? "Pick one or more photos you already have."
              : "Pick a photo you already have."}
          </DialogDescription>
        </DialogHeader>

        <div className="dash-filter-tabs w-fit" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "library"}
            className={`dash-filter-tab ${tab === "library" ? "active" : ""}`}
            onClick={() => switchTab("library")}
          >
            <ImageIcon className="h-3.5 w-3.5" aria-hidden />
            Media Library
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "products"}
            className={`dash-filter-tab ${tab === "products" ? "active" : ""}`}
            onClick={() => switchTab("products")}
          >
            <Package className="h-3.5 w-3.5" aria-hidden />
            Product images
          </button>
        </div>

        <div className="max-h-[55vh] min-h-[240px] overflow-y-auto">
          {loading && !loaded ? (
            <div className="flex h-60 items-center justify-center text-[var(--dash-text-3)]">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              <span className="sr-only">Loading photos</span>
            </div>
          ) : loaded?.error ? (
            <p
              role="alert"
              className="flex h-60 items-center justify-center px-4 text-center text-sm text-[var(--dash-text-3)]"
            >
              {loaded.error}
            </p>
          ) : loaded && loaded.items.length === 0 ? (
            <p className="flex h-60 items-center justify-center px-4 text-center text-sm text-[var(--dash-text-3)]">
              {tab === "library"
                ? "Your Media Library is empty. Upload images under Media, or upload one here instead."
                : "No product photos yet."}
            </p>
          ) : (
            <ul
              className={`grid grid-cols-3 gap-2 sm:grid-cols-4 ${loading ? "opacity-60" : ""}`}
              aria-busy={loading}
            >
              {loaded?.items.map((item) => {
                const added = excluded.has(item.url);
                const selected = picked.includes(item.url);
                const disabled = added || (!selected && atLimit);
                const usedBy = usedByLabel(item.products);
                return (
                  <li key={item.url}>
                    <button
                      type="button"
                      onClick={() => toggle(item.url)}
                      disabled={disabled}
                      aria-pressed={selected}
                      aria-label={
                        added
                          ? `${item.filename || "Photo"}, already added`
                          : item.filename || usedBy || "Photo"
                      }
                      className={`group relative block aspect-square w-full overflow-hidden rounded-[var(--dash-radius-sm)] border-2 bg-[var(--dash-surface-2)] transition ${
                        selected
                          ? "border-[var(--dash-accent)]"
                          : "border-transparent hover:border-[var(--dash-border)]"
                      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      <Image
                        src={item.url}
                        unoptimized={!canOptimizeImage(item.url)}
                        alt=""
                        fill
                        sizes="(max-width:640px) 33vw,180px"
                        className="object-cover"
                      />
                      {selected && (
                        <CircleCheck
                          className="absolute right-1.5 top-1.5 h-5 w-5 rounded-full bg-white text-[var(--dash-accent)]"
                          aria-hidden
                        />
                      )}
                      {(added || item.label || usedBy) && (
                        <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-left text-[10.5px] text-white">
                          {added ? "Already added" : item.label || usedBy}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-1 text-[12px] text-[var(--dash-text-3)]">
            {totalPages > 1 && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || loading}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || loading}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={picked.length === 0}
              onClick={() => {
                onSelect(picked);
                onClose();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
