"use client";
import { useEffect, useRef, useState } from "react";
import { CustomCodeFrame } from "@/app/(storefront)/components/sections/custom-code-frame";
import {
  MINK_STOREFRONT_BROWSER_WIDTHS,
  minkStorefrontBrowserIdentity,
  type MinkStorefrontBrowserFrameResult,
  type MinkStorefrontBrowserValidation,
} from "@/lib/mink/storefront-publication-types";
import type { readMinkBuilderReview } from "@/lib/mink/builder-actions";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkLink } from "./mink-link";
type Review = Awaited<ReturnType<typeof readMinkBuilderReview>>;
type Proposal = Extract<MinkArtifact, { type: "builder_proposal" }>;
async function requestReview(
  id: string,
  signal?: AbortSignal,
): Promise<Review> {
  const response = await fetch(`/api/mink/drafts/${id}/builder-action`, {
    cache: "no-store",
    signal,
  });
  const data = await response.json();
  if (!response.ok || !data.review)
    throw Error(data.error ?? "Could not load this Builder review.");
  return data.review;
}
const labels: Record<Proposal["operation"], string> = {
  chrome_update: "Apply to Website Builder draft",
  chrome_publish: "Publish header and footer",
  chrome_revert: "Restore header and footer draft",
  page_create: "Create draft page",
  page_update: "Apply page changes",
  page_delete: "Delete page",
  page_publish: "Publish page",
  page_unpublish: "Unpublish page",
  page_revert: "Restore page draft",
  settings_update: "Apply Website settings",
  brand_update: "Apply logo and accent colour",
};
const titles: Record<Proposal["operation"], string> = {
  chrome_update: "Header and footer changes",
  chrome_publish: "Publish header and footer",
  chrome_revert: "Restore header and footer draft",
  page_create: "Create a draft page",
  page_update: "Page changes",
  page_delete: "Delete page",
  page_publish: "Publish page",
  page_unpublish: "Unpublish page",
  page_revert: "Restore page draft",
  settings_update: "Website settings",
  brand_update: "Logo and accent colour",
};
const completed: Record<Proposal["operation"], string> = {
  chrome_update:
    "Header and footer saved to draft. This action did not publish them.",
  chrome_publish: "Header and footer published to your live store.",
  chrome_revert:
    "Header and footer draft restored. This action did not publish it.",
  page_create: "Draft page created. This action did not publish it.",
  page_update:
    "Page changes saved. Sections go live when published; details of a live page apply now.",
  page_delete: "Page deleted.",
  page_publish: "Page published to your live store.",
  page_unpublish: "Page unpublished and removed from your live store.",
  page_revert: "Page draft restored. This action did not publish it.",
  settings_update: "Website settings applied to your store.",
  brand_update: "Logo and accent colour applied to your live store.",
};
function fieldLabel(field: string) {
  return field
    .replace(/links\.(\d+)/g, (_, index) => `Link ${Number(index) + 1}`)
    .replace(/groups\.(\d+)/g, (_, index) => `Group ${Number(index) + 1}`)
    .replace(/\.href$/, ".Destination")
    .split(".")
    .map((part) =>
      part.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " "),
    )
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" · ");
}
export function MinkBuilderProposalCard({
  proposal,
  onPrompt,
  promptDisabled = false,
}: {
  proposal: Proposal;
  onPrompt?: (prompt: string) => void;
  promptDisabled?: boolean;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [checkRun, setCheckRun] = useState(0);
  const [checks, setChecks] = useState<
    Record<string, MinkStorefrontBrowserValidation>
  >({});
  const idempotency = useRef<string | null>(null);
  async function refreshReview() {
    setBusy(true);
    setError(null);
    try {
      const value = await requestReview(proposal.draftId);
      setReview(value);
      setDone(value.executed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void requestReview(proposal.draftId, controller.signal)
      .then((value) => {
        setReview(value);
        setDone(value.executed);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [proposal.draftId]);
  async function approve() {
    setBusy(true);
    setError(null);
    try {
      idempotency.current ??= crypto.randomUUID();
      const response = await fetch(
        `/api/mink/drafts/${proposal.draftId}/builder-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            idempotencyKey: idempotency.current,
            browserChecks: checks,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok || !data.result)
        throw Error(data.error ?? "Could not apply this Builder change.");
      setDone(true);
      // Re-read the saved draft: pre-save diagnostics and digests are stale.
      try {
        setReview(await requestReview(proposal.draftId));
      } catch {
        setError(
          "Your change was saved, but publication status could not be checked. Check it again below.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const active = review && !review.executed && !done ? review : null;
  const operation = review?.operation ?? proposal.operation;
  const publication = review?.executed ? review.publication : null;
  const draftOperation = [
    "chrome_update",
    "chrome_revert",
    "page_create",
    "page_update",
    "page_revert",
  ].includes(operation);
  const targetLabel =
    publication?.operation === "chrome_publish"
      ? "header and footer"
      : (publication?.pageSlug ?? proposal.pageSlug) === "home"
        ? "homepage"
        : `page “${publication?.pageSlug ?? proposal.pageSlug}”`;
  const ready =
    active &&
    active.codeChecks.every(
      (code) =>
        checks[code.id]?.browser.supported &&
        checks[code.id]?.viewports.desktop.passed &&
        checks[code.id]?.viewports.mobile.passed,
    );
  const changes = active?.changes ?? proposal.changes;
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-violet-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold text-gray-900">
        Website Builder · {titles[operation]}
      </h3>
      <p className="mt-1 text-gray-600">
        {active?.explanation ?? proposal.explanation}
      </p>
      {!done && (
        <p className="mt-2 font-medium text-gray-700">
          {(active?.live ?? proposal.live)
            ? operation === "page_update"
              ? "Approval changes live page details. Page sections stay in draft until published."
              : "Approval changes the live storefront. Review every change below."
            : "Approving saves this to your private draft. Publish it separately when you are ready."}
          {(operation === "chrome_publish" || operation === "page_publish") &&
            " This publishes the whole current draft, including other unpublished edits."}
        </p>
      )}
      {operation === "page_delete" && (
        <p className="mt-2 text-red-700">
          This removes the page. Existing links to it may stop working.
        </p>
      )}
      <details className="mt-3" open>
        <summary className="cursor-pointer font-medium">
          Review {changes.length} changed{" "}
          {changes.length === 1 ? "field" : "fields"}
        </summary>
        <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
          {changes.map((change, index) => (
            <div key={index} className="rounded-lg bg-gray-50 p-2">
              <p className="break-all font-medium">
                {fieldLabel(change.field)}
              </p>
              <pre className="mt-1 whitespace-pre-wrap break-all text-xs text-gray-500">
                Before: {change.before}
              </pre>
              <pre className="mt-1 whitespace-pre-wrap break-all text-xs text-gray-900">
                After: {change.after}
              </pre>
            </div>
          ))}
        </div>
      </details>
      {!done &&
        active?.codeChecks.map((code) => (
          <CodeChecks
            key={`${code.id}:${checkRun}`}
            id={code.id}
            config={code.config}
            digest={active.patchDigest}
            onChecked={(value) =>
              setChecks((old) => ({ ...old, [code.id]: value }))
            }
          />
        ))}
      {!done && !!active?.codeChecks.length && (
        <button
          type="button"
          className="mt-3 underline"
          disabled={busy}
          onClick={() => {
            setChecks({});
            setCheckRun((run) => run + 1);
          }}
        >
          Run desktop and mobile checks again
        </button>
      )}
      {error && (
        <p role="alert" className="mt-3 text-red-700">
          {error}
        </p>
      )}
      {done ? (
        <p role="status" className="mt-3 font-medium text-green-700">
          {completed[operation]}
        </p>
      ) : (
        <button
          type="button"
          className="mt-3 rounded-lg bg-violet-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
          disabled={!ready || busy}
          onClick={approve}
        >
          {busy ? "Applying…" : labels[operation]}
        </button>
      )}
      {done && draftOperation && publication && (
        <div className="mt-3 rounded-lg bg-gray-50 p-3">
          {publication.status === "live" ? (
            <p className="font-medium text-green-700">
              The current {targetLabel} draft matches your live store.
            </p>
          ) : (
            <>
              <p className="font-medium text-gray-900">
                Next: publish your {targetLabel}. The current draft is not live.
              </p>
              {publication.status === "blocked" ? (
                <>
                  <p className="mt-2 text-amber-800">
                    Resolve these issues before publishing:
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-gray-700">
                    {publication.blockers.map((blocker, index) => (
                      <li key={index}>{blocker}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-1 text-gray-600">
                  Review the whole saved draft, including other unpublished
                  edits, then approve its publication in chat.
                </p>
              )}
              {onPrompt ? (
                <button
                  type="button"
                  className="mt-3 rounded-lg bg-violet-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
                  disabled={busy || promptDisabled}
                  onClick={() =>
                    onPrompt(
                      publication.status === "blocked"
                        ? `Help me resolve publishing issues in my ${targetLabel} draft. Read the current Website Builder context. Prepare exact corrections for unambiguous destinations and ask me to choose when a destination is missing or unclear. Do not remove links or publish pages just to bypass checks. Keep corrections in draft for review.`
                        : `Prepare a publication review for my saved ${targetLabel} draft. Read the current publication context and review the whole draft, including other unpublished edits. If publication is blocked, explain the current issues and the next action. I will approve publication in the review card.`,
                    )
                  }
                >
                  {publication.status === "blocked"
                    ? "Ask Mink to fix publishing issues"
                    : "Review publication"}
                </button>
              ) : (
                <p className="mt-2 text-gray-600">
                  Ask Mink to{" "}
                  {publication.status === "blocked"
                    ? "help resolve these publishing issues"
                    : `prepare publication of your ${targetLabel}`}{" "}
                  in this conversation.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {done && draftOperation && (
        <button
          type="button"
          className="mt-2 underline"
          disabled={busy}
          onClick={refreshReview}
        >
          {busy ? "Checking publication status…" : "Check publication status"}
        </button>
      )}
      {!review && error && (
        <button
          type="button"
          className="ml-3 underline"
          onClick={() => {
            setError(null);
            void requestReview(proposal.draftId)
              .then((value) => {
                setReview(value);
                setDone(value.executed);
              })
              .catch((e) => setError(e.message));
          }}
        >
          Reload review
        </button>
      )}
      <MinkLink
        className="ml-3 inline-block py-2 text-violet-700 underline"
        href="/dashboard/builder"
        target="_blank"
        rel="noreferrer"
      >
        Open Website Builder
      </MinkLink>
    </section>
  );
}
function CodeChecks({
  id,
  config,
  digest,
  onChecked,
}: {
  id: string;
  config: import("@/lib/sections/registry").CustomCodeConfig;
  digest: string;
  onChecked: (value: MinkStorefrontBrowserValidation) => void;
}) {
  const [token] = useState(() => crypto.randomUUID());
  const frames = useRef<
    Partial<Record<"desktop" | "mobile", MinkStorefrontBrowserFrameResult>>
  >({});
  const [status, setStatus] = useState("Checking desktop and mobile…");
  function result(value: MinkStorefrontBrowserFrameResult) {
    frames.current[value.viewport] = value;
    const { desktop, mobile } = frames.current;
    if (!desktop || !mobile) return;
    const withoutToken = ({
      token: _token,
      ...rest
    }: MinkStorefrontBrowserFrameResult) => {
      void _token;
      return rest;
    };
    const browser = minkStorefrontBrowserIdentity(navigator.userAgent);
    onChecked({
      schemaVersion: 1,
      patchDigest: digest,
      checkedAt: new Date().toISOString(),
      browser,
      viewports: {
        desktop: withoutToken(desktop),
        mobile: withoutToken(mobile),
      },
    });
    setStatus(
      !browser.supported
        ? "Use a current Chrome, Edge, Firefox or Safari browser before publishing."
        : desktop.passed && mobile.passed
          ? "Desktop and mobile checks passed."
          : "Code checks found an issue. Ask Mink to correct this section before publishing.",
    );
  }
  return (
    <details open className="mt-3">
      <summary className="cursor-pointer">
        Custom section {id}: {status}
      </summary>
      <div className="mt-2 max-h-72 overflow-auto">
        {(["desktop", "mobile"] as const).map((viewport) => (
          <div
            key={viewport}
            style={{ width: MINK_STOREFRONT_BROWSER_WIDTHS[viewport] }}
          >
            <CustomCodeFrame
              config={config}
              strictNetworkIsolation
              validation={{
                token,
                viewport,
                width: MINK_STOREFRONT_BROWSER_WIDTHS[viewport],
                onResult: result,
              }}
            />
          </div>
        ))}
      </div>
    </details>
  );
}
