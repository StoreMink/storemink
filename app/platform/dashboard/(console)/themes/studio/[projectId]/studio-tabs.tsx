"use client";

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useSearchParams } from "next/navigation";
import type { StudioActionKind } from "../studio-status";
import {
  STUDIO_PAGE_PARAMS,
  studioIntentFromParam,
  type StudioPageApi,
} from "./tab-types";

// ---------------------------------------------------------------------------
// The theme page's client plumbing (wave TS-2, builder 2B): the page API the
// tabs and the release controls call (`useStudioPage`), the keyboard tab bar,
// the `?do=` intent channel, the phone breakpoint and the popover that is a
// bottom sheet on a phone.
//
// ★ TABS FOLLOW THE WAI-ARIA TABS PATTERN WITH MANUAL ACTIVATION. Arrow keys,
// Home and End move focus along the bar (a roving tabindex: only the selected
// tab is in the Tab order); Enter, Space or a click opens the focused tab.
// Every tab but Preview renders on the server, so opening one is a request;
// the pattern's own advice for panels that load with a delay is to activate
// on Enter rather than on every arrow key, which would send one request per
// tab passed over.
//
// ★ AN INTENT NEVER ACTS BY ITSELF. `?do=` (STUDIO_PAGE_PARAMS.intent) only
// opens its control's dialog or confirm, or moves focus to the control; it
// never runs paid work or a change. `useStudioIntent` acts on one once, then
// takes it out of the address with `history.replaceState`, which Next.js
// integrates with `useSearchParams`.
// ---------------------------------------------------------------------------

const StudioPageContext = createContext<StudioPageApi | null>(null);

/** Provides the page API to everything inside the theme page. */
export function StudioPageProvider({
  api,
  children,
}: {
  api: StudioPageApi;
  children: ReactNode;
}) {
  return (
    <StudioPageContext.Provider value={api}>
      {children}
    </StudioPageContext.Provider>
  );
}

/**
 * The theme page's API (tab-types.ts `StudioPageApi`) for a client part inside
 * a tab or the release controls. Throws outside the theme page, so a part
 * rendered somewhere else fails loudly in its test instead of doing nothing.
 */
export function useStudioPage(): StudioPageApi {
  const api = useContext(StudioPageContext);
  if (!api)
    throw new Error(
      "useStudioPage() is used outside the theme page: render it inside the theme page's workspace.",
    );
  return api;
}

// ------------------------------------------------------------------ phones

/** The phone layout's breakpoint (dashboard.css uses the same 767 px). */
export const STUDIO_PHONE_QUERY = "(max-width: 767px)";

function phoneQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  return window.matchMedia(STUDIO_PHONE_QUERY);
}

function subscribePhone(listener: () => void): () => void {
  const query = phoneQuery();
  if (!query) return () => {};
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Whether the screen is phone-sized now (false on the server). */
export function isPhoneNow(): boolean {
  return phoneQuery()?.matches ?? false;
}

/** Whether the screen is phone-sized; the server renders the wide layout and
 * the browser corrects it after hydration without a mismatch. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhoneNow, () => false);
}

// --------------------------------------------------------------------- tabs

export interface StudioTabItem {
  key: string;
  label: string;
  /** A small count beside the label ("Checks 2"); hidden when 0 or null. */
  count?: number | null;
  /** Shown on phones only (the Chat tab): skipped by the arrow keys on a
   * wide screen, where the chat is a column of its own. */
  phoneOnly?: boolean;
}

export function studioTabId(prefix: string, key: string): string {
  return `${prefix}-tab-${key}`;
}

export function studioPanelId(prefix: string, key: string): string {
  return `${prefix}-panel-${key}`;
}

/** A keyboard-accessible tab bar (WAI-ARIA tabs, manual activation). */
export function StudioTabList({
  label,
  items,
  selected,
  onSelect,
  idPrefix,
}: {
  label: string;
  items: readonly StudioTabItem[];
  /** The selected tab's key; on a phone the Chat tab may be the one. */
  selected: string;
  onSelect: (key: string) => void;
  idPrefix: string;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const strip = useRef<HTMLDivElement>(null);

  // ★ A STRIP WIDER THAN ITS ROOM SAYS SO. On a phone the tabs run past the
  // edge and the strip shows no scroll bar, so the side with more tabs fades
  // out (studio.css, `data-more-start` and `data-more-end`). Written on the
  // element itself, so a scroll never re-renders the page.
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const update = () => {
      node.toggleAttribute("data-more-start", node.scrollLeft > 1);
      node.toggleAttribute(
        "data-more-end",
        node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      );
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    resize?.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      resize?.disconnect();
    };
  }, [items.length]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    const phone = isPhoneNow();
    const keys = items
      .filter((item) => phone || !item.phoneOnly)
      .map((item) => item.key);
    const at = keys.indexOf(key);
    if (at < 0 || keys.length === 0) return;
    let next: string;
    switch (event.key) {
      case "ArrowRight":
        next = keys[(at + 1) % keys.length];
        break;
      case "ArrowLeft":
        next = keys[(at - 1 + keys.length) % keys.length];
        break;
      case "Home":
        next = keys[0];
        break;
      case "End":
        next = keys[keys.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons.current.get(next)?.focus();
  }

  return (
    <div ref={strip} role="tablist" aria-label={label} className="studio-tabs">
      {items.map((item) => {
        const isSelected = item.key === selected;
        return (
          <button
            key={item.key}
            ref={(node) => {
              if (node) buttons.current.set(item.key, node);
              else buttons.current.delete(item.key);
            }}
            type="button"
            role="tab"
            id={studioTabId(idPrefix, item.key)}
            aria-selected={isSelected}
            aria-controls={studioPanelId(idPrefix, item.key)}
            tabIndex={isSelected ? 0 : -1}
            className={
              item.phoneOnly ? "studio-tab studio-tab-chat" : "studio-tab"
            }
            onClick={() => onSelect(item.key)}
            onKeyDown={(event) => onKeyDown(event, item.key)}
          >
            {item.label}
            {item.count ? (
              <span className="studio-tab-count">
                <span className="sr-only">, </span>
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ intents

/** Take `?do=` out of the address without a request. */
export function clearStudioIntent(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(STUDIO_PAGE_PARAMS.intent)) return;
  url.searchParams.delete(STUDIO_PAGE_PARAMS.intent);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

/**
 * Act once on the address's intent when it is one of `kinds`: `onIntent`
 * opens a dialog, a confirm or a list, or moves focus; it never runs work.
 * The intent is then removed from the address, unless `keep` says the
 * handler passed it on (a tab acts on it after the switch). The same intent
 * arriving again later (the address lost it in between) acts again.
 */
export function useStudioIntent(
  kinds: readonly StudioActionKind[],
  onIntent: (kind: StudioActionKind) => void | "keep",
): void {
  const params = useSearchParams();
  const intent = studioIntentFromParam(params.get(STUDIO_PAGE_PARAMS.intent));
  const handled = useRef<StudioActionKind | null>(null);
  const act = useEffectEvent((kind: StudioActionKind) => onIntent(kind));
  const wanted = intent !== null && kinds.includes(intent);
  useEffect(() => {
    if (!intent) {
      handled.current = null;
      return;
    }
    if (!wanted || handled.current === intent) return;
    handled.current = intent;
    if (act(intent) !== "keep") clearStudioIntent();
  }, [intent, wanted]);
}

// ----------------------------------------------------------------- popovers

const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A list that drops below (or above) its button on a wide screen and is a
 * bottom sheet on a phone (studio.css `studio-popover`: at most 85% of the
 * screen's height, and it scrolls). Focus moves into it when it opens;
 * Escape, a press outside it or the backdrop closes it, and Escape returns
 * focus to the button that opened it.
 */
export function StudioPopover({
  id,
  open,
  onOpenChange,
  triggerRef,
  label,
  align = "end",
  place = "below",
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLElement | null>;
  /** Names the list for assistive technology and titles the phone sheet. */
  label: string;
  align?: "start" | "end";
  place?: "below" | "above";
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLButtonElement>(null);
  // ★ THE PHONE'S DIM BACKDROP COUNTS AS INSIDE for a press. Closed on
  // pointerdown, it would be gone before the tap ended, and Chrome on
  // Android sends the tap's click to whatever lies under the finger: the
  // header's Check again or Start building, with no confirm. The backdrop's
  // own click closes the sheet instead, and gives focus back.
  function inside(target: EventTarget | null): boolean {
    return (
      target instanceof Node &&
      Boolean(
        panel.current?.contains(target) ||
        triggerRef.current?.contains(target) ||
        backdrop.current?.contains(target),
      )
    );
  }
  function close(returnFocus: boolean) {
    onOpenChange(false);
    if (returnFocus) triggerRef.current?.focus();
  }
  const closeFromDocument = useEffectEvent(
    (returnFocus: boolean, target: EventTarget | null) => {
      if (target !== null && inside(target)) return;
      close(returnFocus);
    },
  );

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeFromDocument(true, null);
    }
    function onPointer(event: PointerEvent) {
      closeFromDocument(false, event.target);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!open) return null;
  return (
    <>
      <button
        ref={backdrop}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="studio-popover-backdrop"
        onClick={() => close(true)}
      />
      <div
        ref={panel}
        id={id}
        role="group"
        aria-label={label}
        className="studio-popover"
        data-align={align}
        data-place={place}
        onBlur={(event) => {
          // Only a move of focus to something outside (Tab past the end)
          // closes it; a press on plain words inside leaves no target.
          if (event.relatedTarget && !inside(event.relatedTarget)) close(false);
        }}
      >
        <p className="studio-sheet-title" aria-hidden="true">
          {label}
        </p>
        {children}
      </div>
    </>
  );
}
