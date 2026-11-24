"use client";

import {
  CheckCircle2,
  Circle,
  CircleSlash,
  ExternalLink,
  Eye,
  Globe,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { usePoll } from "@/lib/pos/use-poll";
import { randomUuid } from "@/lib/random-uuid";
import {
  ACTIVE_REVAMP_STATUSES,
  REVAMP_STEP_LABELS,
  countLabel,
  initialRevampProgress,
  type RevampArtifact,
  type RevampProgressItem,
  type RevampReview,
  type RevampReviewPage,
  type RevampStatus,
  type RevampStatusView,
  type RevampStepState,
} from "@/lib/mink/revamp/contract";
import type {
  RevampPublishResult,
  RevampUndoResult,
} from "@/lib/mink/revamp/lifecycle-types";
import { MINK_REVAMP_REFINE_PROMPTS } from "@/lib/mink/follow-ups";
import { useChat } from "./chat-context";
import { MinkLink } from "./mink-link";
import { MinkRevampPreview } from "./mink-revamp-preview";

/**
 * The live card a storefront revamp adds to the chat.
 *
 * ★ THE ARTIFACT IS AN ID, NOT THE PLAN. The answer ends at once while the
 *   job runs in the background, so the card asks the owner-checked status
 *   route for everything it shows, every few seconds while the job is still
 *   building and only while the tab is visible (`usePoll`: hidden tabs and
 *   offline tills do not poll, and a returning tab catches up at once).
 *
 * ★★ WHAT GOES LIVE AT ONCE IS SAID BEFORE THE BUTTON, the v1 card's rule:
 *   categories, new products and the hidden samples have no draft, so the
 *   merchant reads `liveChanges` before pressing Apply, not after.
 *
 * ★ APPLY IS THE v1 FLOW, UNCHANGED: a preview creates the exact short-lived
 *   approval and the execute consumes it, through the same
 *   personalisation-action route, so an unknown outcome keeps the approval
 *   and a retry cannot apply twice. Publish and Undo are the revamp route's
 *   own actions, both idempotent on the server.
 *
 * ★ NO PRICE OF THE REDESIGN APPEARS HERE. The status view carries none, and
 *   the card never says what anything costs (no-credit-prices.test.ts).
 */

/** How often the card asks while the job is building. */
export const REVAMP_POLL_MS = 3_000;

type Problem = "forbidden" | "missing";
type Busy = "stop" | "apply" | "publish" | "undo";

const STATE_WORDS: Record<RevampStepState, string> = {
  waiting: "Not started",
  running: "In progress",
  done: "Done",
  skipped: "Skipped",
};

const PROBLEM_TEXT: Record<Problem, string> = {
  forbidden:
    "You no longer have access to Website Builder, so this redesign can't be shown here.",
  missing: "This redesign is no longer available.",
};

const UNKNOWN_APPLY =
  "We could not confirm whether your storefront changed. Check Website Builder, or retry; it can't apply twice.";

const RUPEES = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function isActive(status: RevampStatus): boolean {
  return ACTIVE_REVAMP_STATUSES.includes(status);
}

export function MinkRevampCard({ artifact }: { artifact: RevampArtifact }) {
  const id = artifact.revampId;
  const { send, isReplying } = useChat();
  const [view, setView] = useState<RevampStatusView | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ id: string } | null>(null);
  const [appliedHere, setAppliedHere] = useState(false);
  const [publishResult, setPublishResult] =
    useState<RevampPublishResult | null>(null);
  const [undoResult, setUndoResult] = useState<RevampUndoResult | null>(null);
  const [confirmingUndo, setConfirmingUndo] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [designReview, setDesignReview] = useState<RevampReview | null>(null);
  const [designLoading, setDesignLoading] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);

  const status: RevampStatus = view?.status ?? artifact.status;

  const take = useCallback((next: Loaded) => {
    if (next.problem) setProblem(next.problem);
    else if (next.view) setView(next.view);
  }, []);

  // One read on mount: the artifact only knows the status at the moment the
  // answer was written. The poll below takes over while the job is building.
  useEffect(() => {
    const controller = new AbortController();
    void readRevamp(id, controller.signal)
      .then(take)
      .catch(() => undefined);
    return () => controller.abort();
  }, [id, take]);

  usePoll(
    async (run) => {
      const next = await readRevamp(id, run.signal).catch(() => null);
      if (!next || !run.isCurrent()) return;
      take(next);
    },
    { ms: REVAMP_POLL_MS, enabled: !problem && isActive(status) },
  );

  const refresh = useCallback(() => {
    void readRevamp(id)
      .then(take)
      .catch(() => undefined);
  }, [id, take]);

  const loadDesign = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/mink/revamps/${encodeURIComponent(id)}?preview=design`,
        { cache: "no-store", signal },
      );
      if (!response.ok)
        throw new Error("The design preview could not be loaded. Try again.");
      const payload = await response.json();
      if (payload.design?.review && !signal?.aborted)
        setDesignReview(payload.design.review as RevampReview);
    },
    [id],
  );

  async function openDesign() {
    setError(null);
    setDesignLoading(true);
    try {
      await loadDesign();
      setPreviewOpen(true);
    } catch (error) {
      setError(
        messageOf(error, "The design preview could not be loaded. Try again."),
      );
    } finally {
      setDesignLoading(false);
    }
  }

  usePoll(
    async (run) => {
      await loadDesign(run.signal).catch(() => undefined);
    },
    { ms: 15_000, enabled: previewOpen && isActive(status) },
  );

  async function stop() {
    setBusy("stop");
    setError(null);
    try {
      const payload = await postRevamp(id, "cancel");
      if (payload.revamp) setView(payload.revamp as RevampStatusView);
      else refresh();
    } catch (thrown) {
      setError(
        messageOf(thrown, "The redesign could not be stopped. Try again."),
      );
    } finally {
      setBusy(null);
    }
  }

  async function apply(draftId: string) {
    setBusy("apply");
    setError(null);
    try {
      // The v1 card's flow: the preview creates the exact approval and the
      // execute consumes it. An approval kept after an unknown outcome is
      // retried as it is, so the same apply cannot happen twice.
      let exact = approval;
      if (!exact) {
        const preview = await requestApply(draftId, {
          action: "preview",
          expectedDraftVersion: 0,
          idempotencyKey: randomUuid(),
        });
        exact = preview.approval?.id ? { id: preview.approval.id } : null;
        if (!exact) throw new Error("The safety check returned no approval.");
        setApproval(exact);
      }
      const response = await requestApply(draftId, {
        action: "execute",
        approvalId: exact.id,
      });
      if (!response.result)
        throw new Error("The apply response was incomplete.");
      setApproval(null);
      setAppliedHere(true);
      refresh();
    } catch (thrown) {
      if (thrown instanceof ApplyRequestError && thrown.outcome === "unknown") {
        setError(UNKNOWN_APPLY);
      } else {
        setApproval(null);
        setError(messageOf(thrown, "Your storefront was not changed."));
      }
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    setBusy("publish");
    setError(null);
    try {
      const payload = await postRevamp(id, "publish");
      setPublishResult(normalizePublish(payload.result));
      refresh();
    } catch (thrown) {
      setError(
        messageOf(
          thrown,
          "We could not confirm that your store was published. Try again; publishing twice changes nothing.",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    setBusy("undo");
    setError(null);
    try {
      const payload = await postRevamp(id, "undo");
      setUndoResult(normalizeUndo(payload.result));
      setConfirmingUndo(false);
      refresh();
    } catch (thrown) {
      setError(
        messageOf(
          thrown,
          "We could not confirm the undo. Try again; undoing twice changes nothing.",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  const applied = Boolean(view?.appliedAt) || appliedHere;
  // ★ Published means something went live, never only that Publish answered:
  //   publish.ts records nothing when every target was skipped (an unfinished
  //   section, a contrast refusal), precisely so the card offers Publish again.
  const published =
    Boolean(view?.publishedAt) || (publishResult?.published.length ?? 0) > 0;
  const undone = Boolean(view?.undoneAt) || undoResult !== null;
  // ★ Undo's answer survives a reload: publish.ts stores it with the apply
  //   snapshot and the status view sends it back, so the card can still name
  //   what Undo kept after the click that produced it is long gone.
  const undoAnswer =
    undoResult ?? (view?.undo ? normalizeUndo(view.undo) : null);

  return (
    <section
      aria-busy={isActive(status) || busy !== null}
      className="overflow-hidden rounded-2xl border border-[#ddd6fe] bg-white shadow-[0_1px_3px_rgba(38,25,77,0.08)]"
    >
      <header className="border-b border-[#ebe7f7] bg-[#fbfaff] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#6d4dff] text-white">
              <Sparkles aria-hidden className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-[#27242d]">
                {artifact.kind === "refine"
                  ? "Changes to your redesign"
                  : "Your store redesign"}
              </h3>
              <p className="mt-0.5 text-[9px] text-[#716d78]">
                {problem
                  ? "Not available"
                  : isActive(status) && view?.cancelRequested === true
                    ? "Stopping"
                    : subtitle(status, applied, published, undone)}
              </p>
            </div>
          </div>
          <MinkLink
            href="/dashboard/builder"
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[9px] font-semibold text-[#5d3fe3] hover:underline"
          >
            Open Builder <ExternalLink aria-hidden className="h-3 w-3" />
          </MinkLink>
        </div>
      </header>

      <div className="space-y-3 p-3">
        {problem ? (
          <Notice tone="neutral">{PROBLEM_TEXT[problem]}</Notice>
        ) : status === "failed" ? (
          <Notice tone="error">
            {view?.error ?? "This redesign could not be finished."}
          </Notice>
        ) : status === "cancelled" ? (
          <Notice tone="neutral">
            You stopped this redesign. Nothing on your store changed.
          </Notice>
        ) : status === "superseded" && !applied ? (
          // ★ Alone only while never applied. An applied one is what sits in
          //   the merchant's draft, and the server still allows its Publish
          //   and Undo, so it keeps its review below.
          <Notice tone="neutral">
            A newer version of this redesign replaced this one.
          </Notice>
        ) : isActive(status) ? (
          <>
            {view?.waiting && !view.cancelRequested ? (
              <Notice tone="neutral">
                The redesign is waiting to continue. Your progress is saved and
                Mink will retry automatically.
              </Notice>
            ) : null}
            <Progress
              progress={view?.progress ?? initialRevampProgress()}
              stopping={busy === "stop"}
              // ★ A running job only RECORDS the stop (the runner sees it at its
              //   next lease renewal), so the answer still says running: the
              //   recorded request, not the click, is what keeps this down.
              stopRequested={view?.cancelRequested === true}
              onStop={() => void stop()}
            />
            {view?.design?.ready && !view.cancelRequested ? (
              <div className="space-y-2">
                <p className="text-[10px] text-[#5f5969]">
                  Your layout, words and colours are ready to preview.
                  Photographs are still being checked.
                </p>
                <button
                  ref={previewButton}
                  type="button"
                  disabled={designLoading}
                  onClick={() => void openDesign()}
                  className="rounded-lg border border-[#ddd6fe] px-3 py-2 text-xs font-semibold text-[#5d3fe3] disabled:opacity-50"
                >
                  {designLoading ? "Loading design" : "Preview design"}
                </button>
              </div>
            ) : null}
          </>
        ) : !view ? (
          <p className="flex items-center gap-2 text-[10px] text-[#5f5969]">
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
            Loading your review…
          </p>
        ) : !view.review ? (
          <Notice tone="neutral">
            Your review is not available right now. Try again in a moment.
          </Notice>
        ) : (
          <>
            {status === "superseded" ? (
              <Notice tone="neutral">
                A newer version of this redesign exists. You applied this one,
                so you can still publish or undo it here.
              </Notice>
            ) : null}
            <Review
              review={view.review}
              draftId={view.draftId}
              applied={applied}
              published={published}
              undone={undone}
              approvalKept={approval !== null}
              busy={busy}
              confirmingUndo={confirmingUndo}
              publishResult={publishResult}
              undoResult={undoAnswer}
              previewButton={previewButton}
              onPreview={() => setPreviewOpen(true)}
              onApply={(draftId) => void apply(draftId)}
              onPublish={() => void publish()}
              onAskUndo={() => setConfirmingUndo(true)}
              onCancelUndo={() => setConfirmingUndo(false)}
              onUndo={() => void undo()}
            />
            {/* ★ The follow-up changes, only once there is something to
                refine (chat-8): under a card still being made they went to
                the Builder's own tools instead. */}
            {status === "ready" && !undone ? (
              <div
                className="flex flex-wrap gap-1.5"
                aria-label="Ask for changes"
              >
                {MINK_REVAMP_REFINE_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={isReplying}
                    onClick={() => send(prompt)}
                    className="rounded-full border border-[#e5e5e5] bg-white px-3 py-1 text-[11px] font-medium text-[#3e3262] transition-colors hover:border-[#cfc4ff] hover:bg-[#fbfaff] disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}

        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>

      {previewOpen &&
      (view?.review ||
        (isActive(status) && designReview && !view?.cancelRequested)) ? (
        <MinkRevampPreview
          review={view?.review ?? designReview!}
          inProgress={isActive(status)}
          // ★ After Apply the draft IS the redesign: the preview then shows
          //   the live store beside the draft instead of the draft twice.
          applied={applied && !undone}
          published={published && !undone}
          onClose={() => {
            setPreviewOpen(false);
            previewButton.current?.focus();
          }}
        />
      ) : null}
    </section>
  );
}

function subtitle(
  status: RevampStatus,
  applied: boolean,
  published: boolean,
  undone: boolean,
): string {
  if (status === "queued") return "Waiting to start";
  if (status === "running") return "Working on it";
  if (status === "failed") return "Could not finish";
  if (status === "cancelled") return "Stopped";
  // An applied one says where it is (draft, live, undone), like any other.
  if (status === "superseded" && !applied) return "Replaced by a newer version";
  if (undone) return "Undone";
  if (published) return "Live on your store";
  if (applied) return "Saved to your Website Builder draft";
  return "Ready for your review";
}

function Progress({
  progress,
  stopping: sending,
  stopRequested,
  onStop,
}: {
  progress: RevampProgressItem[];
  /** The Stop click is on its way. */
  stopping: boolean;
  /** The server has recorded the stop; the runner has not acted on it yet. */
  stopRequested: boolean;
  onStop: () => void;
}) {
  const running = progress.find((item) => item.state === "running");
  const stopping = sending || stopRequested;
  return (
    <div className="space-y-2.5">
      <p className="text-[10px] leading-4 text-[#39363f]">
        {stopRequested
          ? "Stopping the redesign. Mink AI stops at the next safe point, and nothing on your store changes."
          : "Mink AI is redesigning your store. You can keep chatting; this card updates by itself."}
      </p>
      {/* Only the step that is running is announced, not every count. */}
      <p className="sr-only" aria-live="polite">
        {running ? `Working on: ${REVAMP_STEP_LABELS[running.step]}` : ""}
      </p>
      <ol aria-label="Progress" className="space-y-1.5">
        {progress.map((item) => (
          <li
            key={item.step}
            className="flex min-w-0 items-center gap-2 text-[10px] leading-4"
          >
            <StepIcon state={item.state} />
            <span
              className={
                item.state === "waiting"
                  ? "min-w-0 text-[#8a8490]"
                  : "min-w-0 font-medium text-[#39363f]"
              }
            >
              {REVAMP_STEP_LABELS[item.step] ?? item.step}
              <span className="sr-only">, {STATE_WORDS[item.state]}</span>
            </span>
            {item.detail ? (
              <span className="ml-auto shrink-0 tabular-nums text-[#716d78]">
                {item.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <button
        type="button"
        disabled={stopping}
        onClick={onStop}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[#e2dcf3] bg-white px-3 py-1.5 text-[9px] font-semibold text-[#403753] hover:bg-[#f6f3ff] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {stopping ? (
          <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Square aria-hidden className="h-3 w-3" />
        )}
        {stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
}

function StepIcon({ state }: { state: RevampStepState }) {
  if (state === "done")
    return (
      <CheckCircle2
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 text-emerald-600"
      />
    );
  if (state === "running")
    return (
      <LoaderCircle
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 animate-spin text-[#5d3fe3]"
      />
    );
  if (state === "skipped")
    return (
      <CircleSlash
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 text-[#8a8490]"
      />
    );
  return <Circle aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#cfc9dc]" />;
}

function Review({
  review,
  draftId,
  applied,
  published,
  undone,
  approvalKept,
  busy,
  confirmingUndo,
  publishResult,
  undoResult,
  previewButton,
  onPreview,
  onApply,
  onPublish,
  onAskUndo,
  onCancelUndo,
  onUndo,
}: {
  review: RevampReview;
  draftId: string | null;
  applied: boolean;
  published: boolean;
  undone: boolean;
  approvalKept: boolean;
  busy: Busy | null;
  confirmingUndo: boolean;
  publishResult: RevampPublishResult | null;
  undoResult: RevampUndoResult | null;
  previewButton: RefObject<HTMLButtonElement | null>;
  onPreview: () => void;
  onApply: (draftId: string) => void;
  onPublish: () => void;
  onAskUndo: () => void;
  onCancelUndo: () => void;
  onUndo: () => void;
}) {
  const passed = review.checks.filter((check) => check.passed);
  const failed = review.checks.filter((check) => !check.passed);
  const notedPasses = passed.filter((check) => check.note);
  const previewable = review.pages.length > 0;

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-5 text-[#39363f]">{review.summary}</p>

      {review.photos.length ? (
        <div>
          <p className="mb-1.5 text-[9px] font-semibold text-[#4a4260]">
            New photos
          </p>
          <ul className="flex gap-1.5 overflow-x-auto pb-1">
            {review.photos.map((photo) => (
              <li key={photo.url} className="w-28 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={photo.alt}
                  loading="lazy"
                  className="h-20 w-28 rounded-lg border border-[#e7e3ef] bg-[#f4f2fa] object-cover"
                />
                <p className="mt-1 line-clamp-2 text-[8px] leading-3 text-[#716d78]">
                  {photo.where}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.pages.length ? (
        <Group title="Pages">
          {review.pages.map((page) => (
            <li key={page.slug || "home"} className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 font-semibold text-[#403753]">
                <span className="min-w-0 break-words">{page.title}</span>
                {page.create ? <Badge>New page</Badge> : null}
              </p>
              <p>{pageChanges(page)}</p>
            </li>
          ))}
        </Group>
      ) : null}

      {review.products.length || review.hiddenSampleProducts ? (
        <Group title="Products">
          {review.products.map((product) => (
            <li key={product.key} className="flex min-w-0 items-start gap-2">
              {product.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={product.imageUrl}
                  alt=""
                  loading="lazy"
                  className="h-10 w-10 shrink-0 rounded-lg border border-[#e7e3ef] bg-white object-cover"
                />
              ) : null}
              <span className="min-w-0">
                <span className="block break-words font-semibold text-[#403753]">
                  {product.name}
                </span>
                {product.sizePrices?.length ? (
                  // ★ Every size goes on the shop at Apply at its own price, so
                  //   every price is reviewed here, not only the cheapest.
                  <ul
                    aria-label={`${product.name} sizes and prices`}
                    className="space-y-0.5"
                  >
                    {product.sizePrices.map((size) => (
                      <li key={size.label} className="break-words">
                        {size.label} {RUPEES.format(size.price)}
                        {size.mrp !== null && size.mrp > size.price ? (
                          <>
                            {" "}
                            <span className="sr-only">was</span>{" "}
                            <s className="text-[#8a8490]">
                              {RUPEES.format(size.mrp)}
                            </s>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <>
                    {product.sizes.length ? (
                      <span className="block">{product.sizes.join(", ")}</span>
                    ) : null}
                    <span className="block">
                      {RUPEES.format(product.price)}
                      {product.mrp !== null && product.mrp > product.price ? (
                        <>
                          {" "}
                          <span className="sr-only">was</span>
                          <s className="text-[#8a8490]">
                            {RUPEES.format(product.mrp)}
                          </s>
                        </>
                      ) : null}
                    </span>
                  </>
                )}
              </span>
            </li>
          ))}
          {review.hiddenSampleProducts ? (
            <li>
              {countLabel(review.hiddenSampleProducts, "theme sample product")}{" "}
              {review.hiddenSampleProducts === 1 ? "comes" : "come"} off your
              shop
            </li>
          ) : null}
        </Group>
      ) : null}

      {review.categories.length ? (
        <Group title="Categories">
          {review.categories.map((category, index) => (
            <li
              key={`${category.name}-${index}`}
              className="flex items-center gap-2"
            >
              {category.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={category.imageUrl}
                  alt=""
                  loading="lazy"
                  className="h-8 w-8 shrink-0 rounded border border-[#e7e3ef] object-cover"
                />
              ) : null}
              {/* ★ review.ts already words the change ("Hidden from your
                  shop", "Renamed from Fruit"): every one of these goes live at
                  Apply, so the card prints it as sent rather than a generic
                  label that hides a hidden or renamed category. */}
              <span className="min-w-0 break-words">
                {category.action}: {category.name}
              </span>
            </li>
          ))}
        </Group>
      ) : null}

      {review.checks.length ? (
        <Group title="Checks">
          {passed.length ? (
            <li className="flex items-center gap-1.5">
              <CheckCircle2
                aria-hidden
                className="h-3 w-3 shrink-0 text-emerald-600"
              />
              {countLabel(passed.length, "check")} passed
            </li>
          ) : null}
          {failed.map((check) => (
            <li key={check.id} className="flex gap-1.5 text-amber-900">
              <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                <span className="font-semibold">{check.label}</span>
                {check.note ? `: ${check.note}` : null}
              </span>
            </li>
          ))}
          {notedPasses.map((check) => (
            <li key={check.id}>
              <span className="font-semibold">{check.label}:</span> {check.note}
            </li>
          ))}
        </Group>
      ) : null}

      {review.skipped.length ? (
        <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[9px] leading-4 text-amber-900">
          <summary className="cursor-pointer font-semibold">
            Not done this time ({review.skipped.length})
          </summary>
          <ul className="mt-1.5 space-y-1">
            {review.skipped.map((note, index) => (
              <li key={index}>
                <span className="font-semibold">{note.label}:</span>{" "}
                {note.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {review.notes.length ? (
        <ul className="space-y-1 text-[9px] leading-4 text-[#5f5969]">
          {review.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}

      {undone ? (
        <Notice tone="neutral">
          <span className="block font-semibold">You undid this redesign.</span>
          {undoSentence(undoResult)}
          {/* "Undone", not "Put back": an entry may itself be a removal
              ("Removed Mango pickle"), and "Put back: Removed..." reads as
              the opposite of what happened. */}
          {undoResult?.restored.length ? (
            <span className="mt-1 block">
              Undone: {undoResult.restored.join(", ")}
            </span>
          ) : null}
          {undoResult?.kept.length ? (
            <ResultList title="Left as you made it" items={undoResult.kept} />
          ) : null}
        </Notice>
      ) : applied ? (
        <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-4 text-emerald-900">
          <p className="flex items-start gap-2">
            <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="block font-semibold">
                {published
                  ? "Your redesign is live on your store."
                  : "Saved to your Website Builder draft"}
              </span>
              {published
                ? null
                : "Preview it, then publish when you are happy."}
            </span>
          </p>
          {publishResult?.published.length ? (
            <p>Published: {publishResult.published.join(", ")}</p>
          ) : null}
          {publishResult && !published ? (
            // Publish answered and put nothing live: say so, with its
            // reasons, and leave the button below for after they are fixed.
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900">
              <p className="font-semibold">Nothing went live yet.</p>
              {publishResult.skipped.length ? (
                <ResultList
                  title="Not published"
                  items={publishResult.skipped}
                />
              ) : (
                <p>There was nothing new for Publish to put on your store.</p>
              )}
            </div>
          ) : publishResult?.skipped.length ? (
            <ResultList title="Not published" items={publishResult.skipped} />
          ) : null}
          {published ? null : (
            <p className="max-w-lg">
              Publishing puts the whole draft of each changed page, header and
              footer live, including other unpublished edits and the new titles
              and search text.
            </p>
          )}
          {confirmingUndo ? (
            <UndoConfirm
              busy={busy === "undo"}
              onCancel={onCancelUndo}
              onConfirm={onUndo}
            />
          ) : (
            <div className="flex flex-wrap gap-2 border-t border-emerald-200 pt-2">
              {previewable ? (
                <PreviewButton buttonRef={previewButton} onClick={onPreview} />
              ) : null}
              {published ? null : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={onPublish}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-[9px] font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "publish" ? (
                    <LoaderCircle
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  ) : (
                    <Globe aria-hidden className="h-3.5 w-3.5" />
                  )}
                  {busy === "publish" ? "Publishing…" : "Publish to your store"}
                </button>
              )}
              <button
                type="button"
                disabled={busy !== null}
                onClick={onAskUndo}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-[9px] font-semibold text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RotateCcw aria-hidden className="h-3.5 w-3.5" />
                Undo
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border border-[#ded8f4] bg-[#faf8ff] p-3">
          {review.liveChanges.length ? (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[9px] leading-4 text-amber-900">
              <TriangleAlert
                aria-hidden
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
              <div>
                <p className="font-semibold">
                  These change on your shop as soon as you apply:
                </p>
                <ul className="mt-0.5 list-disc pl-4">
                  {review.liveChanges.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                <p className="mt-0.5">
                  Everything else waits until you publish, including the new
                  page titles and search text.
                </p>
              </div>
            </div>
          ) : null}
          <div className="text-[9px] leading-4 text-[#5f5969]">
            <p className="font-semibold text-[#403753]">
              Apply this to your Website Builder draft
            </p>
            <p>Pages are not published until you choose to.</p>
            {approvalKept ? (
              <p className="mt-1 text-amber-800">
                The last apply could not be confirmed. Retry is safe and cannot
                apply twice.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {previewable ? (
              <PreviewButton buttonRef={previewButton} onClick={onPreview} />
            ) : null}
            <button
              type="button"
              disabled={busy !== null || !draftId}
              onClick={() => (draftId ? onApply(draftId) : undefined)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-[#5d3fe3] px-3 py-1.5 text-[9px] font-semibold text-white hover:bg-[#4e32ca] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "apply" ? (
                <LoaderCircle
                  aria-hidden
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
              )}
              {busy === "apply"
                ? "Applying…"
                : approvalKept
                  ? "Retry applying"
                  : "Apply to Website Builder draft"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function UndoConfirm({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  // Focus lands on the safe choice, so a stray Enter keeps the redesign.
  useEffect(() => keep.current?.focus(), []);
  return (
    <div
      role="group"
      aria-label="Undo this redesign?"
      className="space-y-2 border-t border-emerald-200 pt-2"
    >
      <p className="font-semibold">Undo this redesign?</p>
      <p>
        Undo puts your store back the way it was before this redesign, including
        the categories and products it changed. Anything you have edited since
        stays as you made it.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          ref={keep}
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="inline-flex min-h-8 items-center rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-[9px] font-semibold text-emerald-900 hover:bg-emerald-100 disabled:opacity-60"
        >
          Keep the redesign
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-1.5 text-[9px] font-semibold text-white hover:bg-rose-800 disabled:opacity-60"
        >
          {busy ? (
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw aria-hidden className="h-3.5 w-3.5" />
          )}
          {busy ? "Undoing…" : "Undo the redesign"}
        </button>
      </div>
    </div>
  );
}

function PreviewButton({
  buttonRef,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[#d9d2f5] bg-white px-3 py-1.5 text-[9px] font-semibold text-[#403753] hover:bg-[#f6f3ff]"
    >
      <Eye aria-hidden className="h-3.5 w-3.5" />
      Preview
    </button>
  );
}

function ResultList({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; reason: string }>;
}) {
  return (
    <span className="mt-1 block">
      <span className="font-semibold">{title}:</span>
      <span className="mt-0.5 block space-y-0.5">
        {items.map((item, index) => (
          <span key={index} className="block">
            {item.label}: {item.reason}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * What Undo achieved, in one sentence. ★ "Back the way it was" is said only
 * when Undo kept nothing: Undo leaves anything the merchant changed after the
 * redesign as they made it, and claiming the whole store is back contradicts
 * the list of what it kept. With no answer to read (an older revision did not
 * store one) it says what is true of every Undo.
 */
function undoSentence(answer: RevampUndoResult | null): string {
  if (answer && answer.kept.length === 0) {
    return "Your store is back the way it was before it.";
  }
  if (answer) {
    return "Undo put back what was still the redesign's. Your own later changes were kept.";
  }
  return "Undo put back what was still the redesign's and kept your own later changes.";
}

function pageChanges(page: RevampReviewPage): string {
  const { added, removed, kept, photos } = page.changes;
  const parts: string[] = [];
  if (added) parts.push(`${countLabel(added, "section")} added`);
  if (removed) parts.push(`${countLabel(removed, "section")} removed`);
  if (kept) parts.push(`${countLabel(kept, "section")} kept`);
  if (photos) parts.push(countLabel(photos, "new photo"));
  return parts.length ? parts.join(", ") : "No changes";
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#e7e3ef] bg-[#f8f7fa] p-2.5 text-[9px] leading-4 text-[#54505c]">
      <p className="font-semibold text-[#4a4260]">{title}</p>
      <ul className="mt-1.5 space-y-1.5">{children}</ul>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#ddd6fe] bg-[#f8f5ff] px-1.5 py-0.5 text-[8px] font-medium text-[#564a70]">
      {children}
    </span>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "neutral" | "error";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={
        tone === "error"
          ? "flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-800"
          : "rounded-xl border border-[#e7e3ef] bg-[#fbfaff] p-3 text-[10px] leading-4 text-[#4a4260]"
      }
    >
      {tone === "error" ? (
        <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      ) : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requests.
// ---------------------------------------------------------------------------

interface Loaded {
  view?: RevampStatusView;
  problem?: Problem;
}

async function readRevamp(id: string, signal?: AbortSignal): Promise<Loaded> {
  const response = await fetch(`/api/mink/revamps/${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal,
  });
  // 403: the requester lost Builder view; 404: not theirs. Both are final,
  // so the poll stops rather than asking again every few seconds.
  if (response.status === 403) return { problem: "forbidden" };
  if (response.status === 404) return { problem: "missing" };
  if (!response.ok) return {};
  const payload = (await response.json().catch(() => null)) as {
    revamp?: RevampStatusView;
  } | null;
  const revamp = payload?.revamp;
  return revamp && typeof revamp.status === "string" ? { view: revamp } : {};
}

async function postRevamp(
  id: string,
  action: "cancel" | "publish" | "undo",
): Promise<{ revamp?: unknown; result?: unknown }> {
  let response: Response;
  try {
    response = await fetch(`/api/mink/revamps/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
      cache: "no-store",
    });
  } catch {
    throw new Error("Mink AI could not be reached. Check your connection.");
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    revamp?: unknown;
    result?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? "Mink AI couldn't update that redesign.");
  }
  return payload ?? {};
}

class ApplyRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "unknown",
  ) {
    super(message);
  }
}

type ApplyMutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string };

async function requestApply(
  draftId: string,
  body: ApplyMutation,
): Promise<{ approval?: { id?: string }; result?: unknown }> {
  let response: Response;
  try {
    response = await fetch(
      `/api/mink/drafts/${encodeURIComponent(draftId)}/personalization-action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
  } catch {
    throw new ApplyRequestError(UNKNOWN_APPLY, "unknown");
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    approval?: { id?: string };
    result?: unknown;
  } | null;
  if (!response.ok) {
    throw new ApplyRequestError(
      payload?.error ?? "This redesign could not be applied.",
      response.status >= 500 ? "unknown" : "rejected",
    );
  }
  return payload ?? {};
}

function normalizePublish(value: unknown): RevampPublishResult {
  const row = (value ?? {}) as Partial<RevampPublishResult>;
  return {
    published: Array.isArray(row.published) ? row.published : [],
    skipped: Array.isArray(row.skipped) ? row.skipped : [],
  };
}

function normalizeUndo(value: unknown): RevampUndoResult {
  const row = (value ?? {}) as Partial<RevampUndoResult>;
  return {
    restored: Array.isArray(row.restored) ? row.restored : [],
    kept: Array.isArray(row.kept) ? row.kept : [],
  };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
