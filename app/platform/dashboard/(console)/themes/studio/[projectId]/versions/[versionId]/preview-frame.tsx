"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Laptop,
  Loader2,
  RefreshCw,
  Smartphone,
  Tablet,
} from "lucide-react";
import { openThemeStudioPreviewAction } from "@/app/actions/theme-studio-actions";

// ---------------------------------------------------------------------------
// One design's private preview, inside the theme page's Preview tab (wave
// TS-2). The frame asks the server for an entry token only after it mounts,
// so no token is ever rendered into the page's HTML.
//
// ★ IT FITS THE WIDTH AND THE HEIGHT OF ITS BOX (plan section 4). The frame
// is drawn at the viewport's real size and scaled down to whichever of the
// box's width or height is tighter; a phone frame (390 by 844) never runs
// past the bottom of the screen. Below about 900 px of box the first view is
// Tablet (below 600 px, Phone), until the operator picks one.
//
// ★ THE POP-OUT OPENS ITS WINDOW INSIDE THE TAP. A browser allows a new
// window only while it handles the tap; waiting for the token first (as this
// file used to) is what Safari blocks. The window opens at once on a blank
// page and its address is filled in when the token arrives.
// ---------------------------------------------------------------------------

type ViewportKey = "desktop" | "tablet" | "mobile";
type Viewports = Record<ViewportKey, { width: number; height: number }>;

interface Opened {
  origin: string;
  enterToken: string;
  pages: { surface: string; label: string; path: string }[];
  expiresAt: string;
  mintedAt: number;
}

const VIEWPORT_LABELS: Record<
  ViewportKey,
  { label: string; icon: typeof Laptop }
> = {
  desktop: { label: "Desktop", icon: Laptop },
  tablet: { label: "Tablet", icon: Tablet },
  mobile: { label: "Phone", icon: Smartphone },
};

const VIEWPORT_ORDER: ViewportKey[] = ["desktop", "tablet", "mobile"];

/** Entry tokens last ten minutes; renew a little before that. */
const TOKEN_REFRESH_MS = 8 * 60 * 1000;

/** Box widths under which the first view is smaller than Desktop. */
export const PREVIEW_TABLET_BELOW = 900;
export const PREVIEW_PHONE_BELOW = 600;

function enterUrl(opened: Opened, path: string): string {
  const url = new URL("/api/theme-studio/preview/enter", opened.origin);
  url.searchParams.set("token", opened.enterToken);
  url.searchParams.set("path", path);
  return url.toString();
}

/** The first view for a box this wide. */
export function previewStartViewport(boxWidth: number): ViewportKey {
  if (boxWidth < PREVIEW_PHONE_BELOW) return "mobile";
  if (boxWidth < PREVIEW_TABLET_BELOW) return "tablet";
  return "desktop";
}

/** How far a viewport is scaled to fit a box: never above real size. */
export function previewScale(
  box: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / viewport.width, box.height / viewport.height);
}

export function PreviewFrame({
  projectId,
  versionId,
  viewports,
}: {
  projectId: string;
  versionId: string;
  viewports: Viewports;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<ViewportKey | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [path, setPath] = useState("/");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const holder = useRef<HTMLDivElement>(null);

  const accept = useCallback(
    (result: Awaited<ReturnType<typeof openThemeStudioPreviewAction>>) => {
      setLoading(false);
      if (!result.ok || !result.preview) {
        setError(result.error ?? "The preview couldn't be opened.");
        return null;
      }
      setError(null);
      const next = { ...result.preview, mintedAt: Date.now() };
      setOpened(next);
      return next;
    },
    [],
  );

  /** From an event handler: show progress, then open. */
  const open = useCallback(async (): Promise<Opened | null> => {
    setLoading(true);
    try {
      return accept(
        await openThemeStudioPreviewAction({ projectId, versionId }),
      );
    } catch {
      setLoading(false);
      setError("The preview couldn't be opened. Try again.");
      return null;
    }
  }, [accept, projectId, versionId]);

  function fresh(): Opened | null {
    return opened && Date.now() - opened.mintedAt <= TOKEN_REFRESH_MS
      ? opened
      : null;
  }

  // A fresh token for every navigation keeps each frame load self-contained:
  // it does not depend on a cookie a browser may refuse inside a frame.
  async function navigate(nextPath: string) {
    setPath(nextPath);
    const current = fresh() ?? (await open());
    if (current) setFrameSrc(enterUrl(current, nextPath));
  }

  // The first open starts in the loading state, so the effect only sets
  // state once the server has answered.
  useEffect(() => {
    let cancelled = false;
    openThemeStudioPreviewAction({ projectId, versionId })
      .then((result) => {
        if (cancelled) return;
        const first = accept(result);
        if (first) setFrameSrc(enterUrl(first, "/"));
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setError("The preview couldn't be opened. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [accept, projectId, versionId]);

  // The box's size, whenever it changes (the chat folding or being dragged,
  // the window resizing). A hidden tab measures 0 by 0: the last size stays.
  useEffect(() => {
    const element = holder.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width > 0 && height > 0) setBox({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewport: ViewportKey =
    chosen ?? (box ? previewStartViewport(box.width) : "desktop");
  const size = viewports[viewport];
  const scale = box ? previewScale(box, size) : 1;
  const narrow = box ? box.width < PREVIEW_PHONE_BELOW : false;

  function popOut() {
    const ready = fresh();
    if (ready) {
      window.open(enterUrl(ready, path), "_blank", "noopener");
      return;
    }
    // Opened now, inside the tap; filled in when the token arrives.
    const win = window.open("", "_blank");
    if (win) {
      try {
        win.opener = null;
        win.document.title = "Opening the preview";
        win.document.body.textContent = "Opening the preview...";
      } catch {
        // A window the browser keeps apart is still filled in below.
      }
    }
    void open().then((next) => {
      if (!win || win.closed) return;
      if (next) win.location.replace(enterUrl(next, path));
      else win.close();
    });
  }

  return (
    <div className="studio-preview">
      <div className="studio-preview-bar">
        <div role="group" aria-label="Screen size" className="studio-segmented">
          {VIEWPORT_ORDER.map((key) => {
            const { label, icon: Icon } = VIEWPORT_LABELS[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={viewport === key}
                onClick={() => setChosen(key)}
              >
                <Icon aria-hidden="true" className="h-4 w-4" /> {label}
                {/* In a narrow box (a phone, or a tablet beside the chat)
                    the sizes stay in each button's name, not on screen:
                    with them the group is about 470 px wide. */}
                <span className={narrow ? "sr-only" : "studio-muted"}>
                  <span className="sr-only">, </span>
                  {viewports[key].width}×{viewports[key].height}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void navigate(path)}
            disabled={loading}
            className="dash-btn dash-btn-ghost dash-btn-sm"
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" /> Reload
          </button>
          <button
            type="button"
            onClick={popOut}
            disabled={loading && !opened}
            className={
              narrow
                ? "dash-btn dash-btn-primary dash-btn-sm"
                : "dash-btn dash-btn-ghost dash-btn-sm"
            }
          >
            <ExternalLink aria-hidden="true" className="h-4 w-4" /> Open full
            page
          </button>
        </div>
      </div>

      {opened ? (
        <nav aria-label="Preview pages" className="studio-preview-pages">
          {opened.pages.map((page) => (
            <button
              key={page.surface}
              type="button"
              aria-current={page.path === path ? "page" : undefined}
              onClick={() => void navigate(page.path)}
              className="studio-chip"
            >
              {page.label}
            </button>
          ))}
        </nav>
      ) : null}

      {error ? (
        <p role="alert" className="studio-notice" data-tone="warning">
          {error}
        </p>
      ) : null}

      <div ref={holder} className="studio-preview-holder">
        <div
          className="studio-preview-frame"
          style={{
            width: size.width * scale,
            height: size.height * scale,
          }}
        >
          {frameSrc ? (
            <iframe
              key={viewport}
              title={`Theme preview, ${VIEWPORT_LABELS[viewport].label}`}
              src={frameSrc}
              width={size.width}
              height={size.height}
              style={{
                width: size.width,
                height: size.height,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
                border: 0,
              }}
            />
          ) : null}
          {loading ? (
            <div className="studio-preview-wait" role="status">
              <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
              Preparing the preview. The first open of a design builds its
              preview store.
            </div>
          ) : null}
        </div>
      </div>
      <p className="studio-muted text-xs">
        Checkout is off in previews. A preview closes a day after it was last
        opened.
      </p>
    </div>
  );
}
