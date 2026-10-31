"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Search, X } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import {
  blockItemAction,
  resolveTargetAction,
} from "@/app/actions/takedown-actions";
import { listAllStores, type PlatformStoreRow } from "@/app/actions/platform";
import {
  isOrderReason,
  kindWord,
  reasonLabel,
  reasonsForKind,
  type BlockKind,
  type BlockReason,
  type ComplaintKind,
} from "@/lib/moderation/kinds";
import { defaultStoreMessage } from "@/lib/moderation/copy";
import { ROOT_DOMAIN } from "@/lib/store/host";
// Types only: console-read.ts and block.ts are server-only, and a type
// import is erased.
import type {
  ResolvedTarget,
  SearchableKind,
  TargetMatch,
  TargetStore,
  TargetWarning,
} from "@/lib/moderation/console-read";
import type { BlockInput } from "@/lib/moderation/block";
import {
  blockHref,
  blockKindLabel,
  complaintHref,
  istDateTime,
} from "../complaints-console";

// ---------------------------------------------------------------------------
// Block an item (takedown design 6.5): find it, confirm what it is, say why.
//
// ★ THE SERVER IS THE CHECK. Every read is `resolveTargetAction` and the one
// write is `blockItemAction` (app/actions/takedown-actions.ts), each of which
// re-derives the operator and their role; a refusal comes back with the
// design's sentence and is shown as it came. What this form hides from a
// member is only what the server would refuse them anyway.
//
// ★ A MEMBER SEES "TELL THE STORE" TICKED AND UNAVAILABLE, with the reason
// written under it, never in a tooltip (a tooltip does not open on touch).
// Only a superadmin may keep a block from the store (D5), and only a
// superadmin is offered a whole store.
//
// ★ THE PREFILLS FOLLOW THE REASON until the operator edits them: the message
// to the store (design 7.2) and the image tick (ticked for the two orders and
// for an intimate image or impersonation, design 3.1).
// ---------------------------------------------------------------------------

const LABEL = "mb-1 block text-sm font-medium text-[var(--dash-text)]";
const HINT = "mt-1 block text-xs text-[var(--dash-text-2)]";
const ERROR = "mt-1 block text-sm text-[var(--dash-red)]";
const INPUT = "dash-input w-full pointer-coarse:min-h-11";
const PRIMARY = "dash-btn dash-btn-primary pointer-coarse:min-h-11";
const LINK_BUTTON =
  "text-left text-sm text-[var(--dash-accent)] hover:underline pointer-coarse:min-h-11";
const NOTICE =
  "rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)] bg-[var(--dash-amber-soft)] px-3 py-2 text-sm text-[var(--dash-text)]";

/** Shown only when the request itself failed, never for a refusal. */
export const REQUEST_FAILED =
  "The request didn't reach StoreMink. Refresh the page and try again.";

/** A member who reaches a whole store (design 3.10; BLOCK_ERRORS.storeSuperadmin). */
export const STORE_SUPERADMIN_ONLY =
  "Only a superadmin can suspend a whole store.";

/** Under the unavailable "Tell the store" tick of a member (design 6.5). */
export const TELL_MEMBER_NOTE =
  "Only a superadmin can keep a block from the store, when a court or government order says so.";

/** What a superadmin who unticks "Tell the store" reads (design 6.5). */
export const UNTOLD_WARNING =
  "The store gets no email, notice or label on the item. Use this only when an order says so; you can tell it later from the block's page.";

/** A whole store, before it is suspended (design 6.5 with A9: POS). */
export const STORE_SUSPENSION_TEXT =
  "This closes its storefront, its dashboard and its POS on every address, after StoreMink keeps a copy of everything. Its files stay online: block any image that must stop loading as its own item.";

/** The warnings of design 6.5 (the old-storage one is gone, A2). */
export const WARNING_TEXT: Record<
  Exclude<TargetWarning, "already_blocked">,
  string
> = {
  homepage:
    "This is the store's homepage. Blocking it leaves the homepage empty; the rest of the store stays open.",
  theme_release:
    "This image belongs to a theme and appears on every store that uses it.",
  bundled:
    "This image is built into a StoreMink theme, so every store using it will show the placeholder. Removing the file needs a code change (see the runbook).",
  external:
    "StoreMink does not store this file. Pages on this store will stop showing it, but it stays at its own address.",
};

const MESSAGE_HINT =
  "The store sees this. Leave out the complainant's name and contact unless they agreed.";
const LEGAL_BASIS_HINT = "Order number, date and the law it names";
const IMAGES_TICK =
  "Also block these images (they stop loading everywhere they are used)";

/** The kinds whose images may be blocked with them (block.ts IMAGE_BLOCK_KINDS). */
const IMAGE_KINDS: ReadonlySet<BlockKind> = new Set([
  "product",
  "page",
  "blog_post",
  "collection",
]);

const SEARCH_KINDS: readonly SearchableKind[] = [
  "product",
  "page",
  "blog_post",
  "collection",
  "file",
];

/** A complaint this block is for, as the page read it. */
export type BlockFormComplaint = {
  id: string;
  ref: string;
  kind: ComplaintKind;
  storeId: string | null;
  storeLabel: string;
  /** The complaint's first web address, to start the search from. */
  firstUrl: string | null;
};

export type BlockFormProps = {
  superadmin: boolean;
  complaint: BlockFormComplaint | null;
  /** What the page already found (a whole store asked for by the address). */
  initialTarget?: ResolvedTarget | null;
  /** The sentence of a lookup the page made that failed. */
  initialError?: string | null;
  /** A member asked for a whole store: say why it is not offered. */
  storeRefused?: boolean;
};

/** The block reason a complaint of this kind starts from (design 6.5 step 3). */
const REASON_FROM_COMPLAINT: Partial<Record<ComplaintKind, BlockReason>> = {
  court_order: "court_order",
  government_order: "government_order",
  intimate_or_impersonation: "intimate_or_impersonation",
  listed_content: "listed_content",
  other_removal: "other_removal",
};

/**
 * The reason the form starts from: the complaint's, or "Breaks our Acceptable
 * Use Policy" for a block StoreMink makes itself; "" when the complaint's kind
 * names no reason or the reason is not offered for this kind.
 */
export function defaultReason(
  kind: BlockKind,
  complaintKind: ComplaintKind | null,
): BlockReason | "" {
  const reason =
    complaintKind === null
      ? "terms_breach"
      : (REASON_FROM_COMPLAINT[complaintKind] ?? "");
  return reason && reasonsForKind(kind).includes(reason) ? reason : "";
}

/** The image tick starts ticked for the orders and for intimate images (3.1). */
export function imagesTickedFor(reason: BlockReason | ""): boolean {
  return (
    reason === "court_order" ||
    reason === "government_order" ||
    reason === "intimate_or_impersonation"
  );
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "Now: Published", "Now: Open" (design 6.5); null when it has no state. */
export function nowWord(kind: BlockKind, state: string | null): string | null {
  const value = (state ?? "").trim().toLowerCase();
  if (!value) return null;
  if (kind === "store") {
    if (value === "active") return "Open";
    if (value === "suspended") return "Suspended";
  }
  return capitalise(value.replace(/_/g, " "));
}

/** "Product: Blue mug", "Image: hero.webp", "Store: Crumb & Co (crumb...)". */
export function targetHeading(target: ResolvedTarget): string {
  if (target.kind === "store") {
    return `Store: ${target.store?.label ?? target.label}`;
  }
  const word =
    target.kind === "file"
      ? capitalise(
          kindWord("file", target.file?.mediaAsset?.contentType ?? null),
        )
      : blockKindLabel(target.kind);
  return `${word}: ${target.label}`;
}

/** The block a target and the form's answers make (BlockInput, block.ts). */
export function blockInputFor(
  target: ResolvedTarget,
  answers: {
    reason: BlockReason | "";
    legalBasis: string;
    complaintId: string | null;
    storeMessage: string;
    tellStore: boolean;
    alsoBlockImages: boolean;
  },
): BlockInput {
  const storeId = target.store?.id ?? null;
  const base: BlockInput = {
    kind: target.kind,
    storeId,
    // The server names a missing reason ("Choose a reason.").
    reason: answers.reason as BlockReason,
    legalBasis:
      answers.reason && isOrderReason(answers.reason)
        ? answers.legalBasis
        : null,
    complaintId: answers.complaintId,
    storeMessage: answers.storeMessage,
    tellStore: answers.tellStore,
  };
  if (target.kind === "store") return { ...base, itemId: storeId };
  if (target.kind === "file") {
    return { ...base, fileAddress: target.file?.url || target.url };
  }
  const images =
    IMAGE_KINDS.has(target.kind) && answers.alsoBlockImages
      ? target.images.filter((image) => !image.blocked).map((i) => i.url)
      : [];
  return {
    ...base,
    itemId: target.itemId,
    alsoBlockImages: images.slice(0, 50),
  };
}

/** "Crumb & Co (crumb.storemink.com)". */
function storeLabel(store: { name: string; slug: string }): string {
  return `${store.name || store.slug} (${store.slug}.${ROOT_DOMAIN})`;
}

type PickedStore = { id: string; label: string };

/** A store, searched by name or address on the console's own store list. */
function StorePicker({
  label,
  picked,
  onPick,
  onClear,
  disabled,
}: {
  label: string;
  picked: PickedStore | null;
  onPick: (store: PickedStore) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlatformStoreRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function onQuery(value: string) {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    const text = value.trim();
    const mine = ++run.current;
    if (text.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(() => {
      listAllStores(text)
        .then((rows) => {
          if (run.current === mine) setResults(rows);
        })
        .catch(() => {
          if (run.current === mine) setResults([]);
        })
        .finally(() => {
          if (run.current === mine) setSearching(false);
        });
    }, 300);
  }

  if (picked) {
    return (
      <div>
        <span className={LABEL}>{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="dash-badge dash-badge-blue max-w-full break-all">
            {picked.label}
          </span>
          <button
            type="button"
            onClick={() => {
              onClear();
              onQuery("");
            }}
            disabled={disabled}
            className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
          >
            <X aria-hidden className="h-4 w-4" />
            Clear
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={inputId} className={LABEL}>
        {label}
      </label>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--dash-text-3)]"
        />
        <input
          id={inputId}
          className={`${INPUT} pl-9`}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      {searching ? (
        <span className="mt-2 inline-flex items-center gap-2 text-xs text-[var(--dash-text-2)]">
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          Searching
        </span>
      ) : null}
      {!searching && results !== null ? (
        results.length === 0 ? (
          <span className={HINT} role="status">
            No store matches.
          </span>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--dash-border)] rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)]">
            {results.slice(0, 8).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onPick({ id: row.id, label: storeLabel(row) })}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--dash-surface-2)] pointer-coarse:min-h-11"
                >
                  <span className="block font-medium text-[var(--dash-text)]">
                    {row.name || row.slug}
                  </span>
                  <span className="block text-xs text-[var(--dash-text-2)]">
                    {row.slug}.{ROOT_DOMAIN}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** One image of the item: blurred until shown, as the archive viewer does. */
function ImageThumb({ url, blocked }: { url: string; blocked: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <li className="flex items-center gap-3">
      <span className="h-14 w-14 shrink-0 overflow-hidden rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          className={`h-full w-full object-cover ${shown ? "" : "blur-md"}`}
        />
      </span>
      <span className="min-w-0 flex-1 text-xs break-all text-[var(--dash-text-2)]">
        {url}
      </span>
      {blocked ? (
        <span className="dash-badge dash-badge-storemink">Blocked</span>
      ) : null}
      {!shown ? (
        <button
          type="button"
          onClick={() => setShown(true)}
          className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
        >
          Show
        </button>
      ) : null}
    </li>
  );
}

type Matches = {
  store: TargetStore;
  kind: SearchableKind;
  matches: TargetMatch[];
};

type Finder = "address" | "search" | "store";

export function BlockForm({
  superadmin,
  complaint,
  initialTarget = null,
  initialError = null,
  storeRefused = false,
}: BlockFormProps) {
  const router = useRouter();
  const addressId = useId();
  const reasonId = useId();
  const legalId = useId();
  const messageId = useId();
  const searchId = useId();
  const searchKindId = useId();
  const tellNoteId = useId();

  const [finding, startFind] = useTransition();
  const [blocking, startBlock] = useTransition();

  const [address, setAddress] = useState(complaint?.firstUrl ?? "");
  const [finder, setFinder] = useState<Finder>(
    initialTarget?.kind === "store" ? "store" : "address",
  );
  const [findError, setFindError] = useState<string | null>(initialError);
  const [searchStore, setSearchStore] = useState<PickedStore | null>(
    complaint?.storeId
      ? { id: complaint.storeId, label: complaint.storeLabel }
      : null,
  );
  const [suspendStore, setSuspendStore] = useState<PickedStore | null>(
    initialTarget?.kind === "store" && initialTarget.store
      ? { id: initialTarget.store.id, label: initialTarget.store.label }
      : null,
  );
  const [searchKind, setSearchKind] = useState<SearchableKind>("product");
  const [searchText, setSearchText] = useState("");
  const [matches, setMatches] = useState<Matches | null>(null);

  const [target, setTarget] = useState<ResolvedTarget | null>(initialTarget);
  const complaintKind = complaint?.kind ?? null;
  const startReason = initialTarget
    ? defaultReason(initialTarget.kind, complaintKind)
    : "";
  const [reason, setReason] = useState<BlockReason | "">(startReason);
  const [legalBasis, setLegalBasis] = useState("");
  const [message, setMessage] = useState(
    initialTarget && startReason
      ? (defaultStoreMessage(
          startReason,
          initialTarget.kind,
          initialTarget.file?.mediaAsset?.contentType ?? null,
        ) ?? "")
      : "",
  );
  const [messageEdited, setMessageEdited] = useState(false);
  const [tellStore, setTellStore] = useState(true);
  const [alsoImages, setAlsoImages] = useState(imagesTickedFor(startReason));
  const [imagesEdited, setImagesEdited] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const busy = finding || blocking;

  function contentTypeOf(t: ResolvedTarget): string | null {
    return t.file?.mediaAsset?.contentType ?? null;
  }

  /** A new target: every answer starts again from its defaults. */
  function applyTarget(next: ResolvedTarget) {
    const nextReason = defaultReason(next.kind, complaintKind);
    setTarget(next);
    setMatches(null);
    setReason(nextReason);
    setLegalBasis("");
    setMessage(
      nextReason
        ? (defaultStoreMessage(nextReason, next.kind, contentTypeOf(next)) ??
            "")
        : "",
    );
    setMessageEdited(false);
    setTellStore(true);
    setAlsoImages(imagesTickedFor(nextReason));
    setImagesEdited(false);
    setSubmitError(null);
  }

  function find(input: Parameters<typeof resolveTargetAction>[0]) {
    setFindError(null);
    setSubmitError(null);
    startFind(async () => {
      try {
        const res = await resolveTargetAction(input);
        if (!res.ok) {
          setFindError(res.error);
          return;
        }
        if (res.found === "matches") {
          setMatches({
            store: res.store,
            kind: res.kind,
            matches: res.matches,
          });
          return;
        }
        applyTarget(res.target);
      } catch {
        setFindError(REQUEST_FAILED);
      }
    });
  }

  function chooseReason(next: BlockReason | "") {
    setReason(next);
    if (target && !messageEdited) {
      setMessage(
        next
          ? (defaultStoreMessage(next, target.kind, contentTypeOf(target)) ??
              "")
          : "",
      );
    }
    if (!imagesEdited) setAlsoImages(imagesTickedFor(next));
  }

  function submit() {
    if (!target) return;
    setSubmitError(null);
    const input = blockInputFor(target, {
      reason,
      legalBasis,
      complaintId: complaint?.id ?? null,
      storeMessage: message,
      // A member cannot keep a block from the store (D5): always told.
      tellStore: superadmin ? tellStore : true,
      alsoBlockImages: alsoImages,
    });
    startBlock(async () => {
      try {
        const res = await blockItemAction(input);
        if (!res.ok) {
          setSubmitError(res.error);
          return;
        }
        toast.success(res.message);
        for (const warning of res.warnings ?? []) toast.warning(warning);
        router.push(blockHref(res.blockId));
      } catch {
        setSubmitError(REQUEST_FAILED);
      }
    });
  }

  const reasons = target ? reasonsForKind(target.kind) : [];
  const storeTarget = target?.kind === "store";
  const alreadyBlocked = target?.alreadyBlocked ?? null;
  const memberAtStore = storeTarget && !superadmin;
  const showWhy = Boolean(target) && !alreadyBlocked && !memberAtStore;
  const freeImages = target?.images.filter((image) => !image.blocked) ?? [];
  const now = target ? nowWord(target.kind, target.state) : null;
  const picksTitle =
    target?.kind === "product"
      ? "Reviews on it"
      : target?.kind === "blog_post"
        ? "Comments on it"
        : null;

  return (
    <div className="space-y-6">
      {/* Step 1, find it. */}
      <section className="dash-card space-y-4 p-5">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setFinder("address");
            find({ address, storeId: complaint?.storeId ?? null });
          }}
          className="space-y-2"
        >
          <div className="mb-1 flex items-center gap-1.5">
            <label
              htmlFor={addressId}
              className="text-sm font-medium text-[var(--dash-text)]"
            >
              Address
            </label>
            <InfoTip label="About the address">
              Paste the address of a store page or an image.
            </InfoTip>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={addressId}
              className={INPUT}
              value={address}
              placeholder="https://"
              onChange={(e) => setAddress(e.target.value)}
              disabled={busy}
              autoComplete="off"
              inputMode="url"
            />
            <button type="submit" disabled={busy} className={PRIMARY}>
              {finding && finder === "address" ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              Find
            </button>
          </div>
        </form>

        <div className="flex flex-col items-start gap-1 sm:flex-row sm:gap-4">
          <button
            type="button"
            className={LINK_BUTTON}
            aria-expanded={finder === "search"}
            onClick={() => {
              setFinder("search");
              setFindError(null);
            }}
            disabled={busy}
          >
            Or choose a store and search it
          </button>
          {superadmin ? (
            <button
              type="button"
              className={LINK_BUTTON}
              aria-expanded={finder === "store"}
              onClick={() => {
                setFinder("store");
                setFindError(null);
              }}
              disabled={busy}
            >
              Or suspend a whole store
            </button>
          ) : null}
        </div>

        {finder === "search" ? (
          <div className="space-y-3 border-t border-[var(--dash-border)] pt-4">
            <StorePicker
              label="Store"
              picked={searchStore}
              onPick={(store) => {
                setSearchStore(store);
                setMatches(null);
              }}
              onClear={() => {
                setSearchStore(null);
                setMatches(null);
              }}
              disabled={busy}
            />
            {searchStore ? (
              <form
                noValidate
                className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  find({
                    storeId: searchStore.id,
                    kind: searchKind,
                    search: searchText,
                  });
                }}
              >
                <div>
                  <label htmlFor={searchKindId} className={LABEL}>
                    What to search for
                  </label>
                  <select
                    id={searchKindId}
                    className={INPUT}
                    value={searchKind}
                    onChange={(e) =>
                      setSearchKind(e.target.value as SearchableKind)
                    }
                    disabled={busy}
                  >
                    {SEARCH_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {blockKindLabel(kind)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={searchId} className={LABEL}>
                    Search
                  </label>
                  <input
                    id={searchId}
                    className={INPUT}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    disabled={busy}
                    autoComplete="off"
                  />
                </div>
                <button type="submit" disabled={busy} className={PRIMARY}>
                  {finding && finder === "search" ? (
                    <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                  ) : null}
                  Find
                </button>
              </form>
            ) : null}
            {matches ? (
              matches.matches.length === 0 ? (
                <p className={HINT} role="status">
                  No matches.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--dash-border)] rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)]">
                  {matches.matches.map((match) => (
                    <li key={match.itemId}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          matches.kind === "file"
                            ? find({
                                address: match.url,
                                storeId: matches.store.id,
                              })
                            : find({
                                storeId: matches.store.id,
                                kind: matches.kind,
                                itemId: match.itemId,
                              })
                        }
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--dash-surface-2)] pointer-coarse:min-h-11"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-[var(--dash-text)]">
                            {match.label}
                          </span>
                          <span className="block text-xs break-all text-[var(--dash-text-2)]">
                            {match.url}
                          </span>
                        </span>
                        {match.blocked ? (
                          <span className="dash-badge dash-badge-storemink">
                            Blocked
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        ) : null}

        {finder === "store" && superadmin ? (
          <div className="space-y-3 border-t border-[var(--dash-border)] pt-4">
            <StorePicker
              label="Store"
              picked={suspendStore}
              onPick={(store) => {
                setSuspendStore(store);
                find({ storeId: store.id, kind: "store" });
              }}
              onClear={() => setSuspendStore(null)}
              disabled={busy}
            />
          </div>
        ) : null}

        {storeRefused ? (
          <p role="alert" className={ERROR}>
            {STORE_SUPERADMIN_ONLY}
          </p>
        ) : null}
        {findError ? (
          <p role="alert" className={ERROR}>
            {findError}
          </p>
        ) : null}
      </section>

      {/* Step 2, confirm what it is. */}
      {target ? (
        <section className="dash-card space-y-3 p-5" aria-live="polite">
          <p className="text-base font-semibold break-words text-[var(--dash-text)]">
            {targetHeading(target)}
          </p>
          <div className="space-y-1 text-sm break-words text-[var(--dash-text)]">
            {!storeTarget && target.store ? (
              <p>{`Store: ${target.store.label}`}</p>
            ) : null}
            {now ? <p>{`Now: ${now}`}</p> : null}
            {!storeTarget ? <p>{`Appears on: ${target.appearsOn}`}</p> : null}
          </div>
          {storeTarget ? (
            <p className="text-sm text-[var(--dash-text)]">
              {STORE_SUSPENSION_TEXT}
            </p>
          ) : null}

          {target.warnings.map((warning) =>
            warning === "already_blocked" ? (
              alreadyBlocked ? (
                <p key={warning} className={NOTICE}>
                  {`This is already blocked (since ${istDateTime(alreadyBlocked.blockedAt)}). `}
                  <Link
                    href={blockHref(alreadyBlocked.blockId)}
                    className="font-medium text-[var(--dash-accent)] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                  >
                    Open the block
                  </Link>
                  .
                </p>
              ) : null
            ) : (
              <p key={warning} className={NOTICE}>
                {WARNING_TEXT[warning]}
              </p>
            ),
          )}

          {picksTitle && target.picks.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-medium text-[var(--dash-text)]">
                {picksTitle}
              </h3>
              <ul className="divide-y divide-[var(--dash-border)] rounded-[var(--dash-radius-sm)] border border-[var(--dash-border-strong)]">
                {target.picks.map((pick) => (
                  <li
                    key={pick.id}
                    className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
                  >
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block text-[var(--dash-text)]">
                        {pick.excerpt}
                      </span>
                      <span className="block text-xs text-[var(--dash-text-2)]">
                        {`${pick.author} · ${istDateTime(pick.at)}`}
                      </span>
                    </span>
                    {pick.blocked ? (
                      <span className="dash-badge dash-badge-storemink">
                        Blocked
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
                        disabled={busy || !target.store}
                        onClick={() =>
                          target.store
                            ? find({
                                storeId: target.store.id,
                                kind: pick.kind,
                                itemId: pick.id,
                              })
                            : undefined
                        }
                      >
                        {pick.kind === "review"
                          ? "Block this review"
                          : "Block this comment"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {IMAGE_KINDS.has(target.kind) && target.images.length > 0 ? (
            <div className="space-y-2">
              <ul className="space-y-2">
                {target.images.map((image) => (
                  <ImageThumb
                    key={image.key}
                    url={image.url}
                    blocked={image.blocked}
                  />
                ))}
              </ul>
              {showWhy && freeImages.length > 0 ? (
                <label className="flex items-start gap-2 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={alsoImages}
                    onChange={(e) => {
                      setAlsoImages(e.target.checked);
                      setImagesEdited(true);
                    }}
                    disabled={busy}
                  />
                  <span>{IMAGES_TICK}</span>
                </label>
              ) : null}
            </div>
          ) : null}

          {memberAtStore ? (
            <p role="alert" className={ERROR}>
              {STORE_SUPERADMIN_ONLY}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Step 3, why. */}
      {showWhy && target ? (
        <form
          noValidate
          className="dash-card space-y-5 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div>
            <label htmlFor={reasonId} className={LABEL}>
              Reason
            </label>
            <select
              id={reasonId}
              className={INPUT}
              value={reason}
              onChange={(e) => chooseReason(e.target.value as BlockReason | "")}
              disabled={blocking}
            >
              {reason === "" ? (
                <option value="" disabled>
                  Choose a reason
                </option>
              ) : null}
              {reasons.map((value) => (
                <option key={value} value={value}>
                  {reasonLabel(value)}
                </option>
              ))}
            </select>
          </div>

          {reason && isOrderReason(reason) ? (
            <div>
              <label htmlFor={legalId} className={LABEL}>
                Legal basis
              </label>
              <textarea
                id={legalId}
                className="dash-input w-full"
                rows={2}
                value={legalBasis}
                onChange={(e) => setLegalBasis(e.target.value)}
                disabled={blocking}
                aria-describedby={`${legalId}-hint`}
              />
              <span id={`${legalId}-hint`} className={HINT}>
                {LEGAL_BASIS_HINT}
              </span>
            </div>
          ) : null}

          <div>
            <span className={LABEL}>Complaint</span>
            {complaint ? (
              <Link
                href={complaintHref(complaint.ref)}
                className="text-sm text-[var(--dash-accent)] tabular-nums hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                {complaint.ref}
              </Link>
            ) : (
              <p className="text-sm text-[var(--dash-text)]">
                {reason === "store_request"
                  ? "No complaint: the store asked us"
                  : "No complaint: StoreMink found it"}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={messageId} className={LABEL}>
              Message to the store
            </label>
            <textarea
              id={messageId}
              className="dash-input w-full"
              rows={4}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setMessageEdited(true);
              }}
              disabled={blocking}
              aria-describedby={`${messageId}-hint`}
            />
            <span id={`${messageId}-hint`} className={HINT}>
              {MESSAGE_HINT}
            </span>
          </div>

          <div>
            <label className="flex items-start gap-2 text-sm text-[var(--dash-text)] pointer-coarse:min-h-11">
              <input
                type="checkbox"
                className="mt-1"
                checked={superadmin ? tellStore : true}
                onChange={(e) => setTellStore(e.target.checked)}
                disabled={!superadmin || blocking}
                aria-describedby={!superadmin ? tellNoteId : undefined}
              />
              <span>Tell the store</span>
            </label>
            {!superadmin ? (
              <span id={tellNoteId} className={HINT}>
                {TELL_MEMBER_NOTE}
              </span>
            ) : !tellStore ? (
              <p role="status" className={`mt-2 ${NOTICE}`}>
                {UNTOLD_WARNING}
              </p>
            ) : null}
          </div>

          {submitError ? (
            <p role="alert" className="text-sm text-[var(--dash-red)]">
              {submitError}
            </p>
          ) : null}

          <div className="flex justify-end">
            <button type="submit" disabled={blocking} className={PRIMARY}>
              {blocking ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              {storeTarget ? "Suspend the store" : "Block now"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
