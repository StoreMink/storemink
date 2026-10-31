"use client";

import {
  CheckCircle2,
  ExternalLink,
  EyeOff,
  Globe,
  Images,
  LoaderCircle,
  PackageX,
  ShieldCheck,
  Sparkles,
  Tags,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { publishChrome } from "@/app/actions/chrome-actions";
import { publishPage } from "@/app/actions/page-actions";
import { SECTION_TYPE_META } from "@/lib/sections/registry";
import type {
  MinkStorefrontPersonalizationActionApproval,
  MinkStorefrontPersonalizationActionResult,
} from "@/lib/mink/storefront-personalization-action-types";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkLink } from "./mink-link";
import {
  PaletteChanges,
  TypeChanges,
} from "./mink-storefront-design-proposal-card";

type Proposal = Extract<
  MinkArtifact,
  { type: "storefront_personalization_proposal" }
>;

/**
 * The one card a storefront personalisation produces.
 *
 * ★ IT LEADS WITH THE PHOTOS, because they are what the merchant asked to
 *   be rid of: the theme's pictures of somebody else's goods. Then what each
 *   page gets, the look, the header and footer copy, the categories and the
 *   sample products.
 *
 * ★★ WHAT GOES LIVE AT ONCE IS SAID BEFORE THE BUTTON. Pages, the header,
 *    footer and look land in the private Builder draft; categories, the
 *    theme's sample products and the store's tagline have no draft, so they
 *    change on the shop when this is applied. A merchant must read that
 *    before pressing Apply, not discover it after.
 *
 * ★ PUBLISHING IS THE MERCHANT'S OWN ACTION, the layout card's rule: the
 *   Publish step calls the same `publishPage` and `publishChrome` the
 *   Builder's own Publish button calls, behind the same permission.
 */
export function MinkStorefrontPersonalizationCard({
  proposal,
}: {
  proposal: Proposal;
}) {
  const [approval, setApproval] =
    useState<MinkStorefrontPersonalizationActionApproval | null>(null);
  const [result, setResult] =
    useState<MinkStorefrontPersonalizationActionResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void readLatestAction(proposal.draftId, controller.signal)
      .then((saved) => {
        if (saved) setResult(saved);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [proposal.draftId]);

  async function apply() {
    setBusy(approval ? "execute" : "preview");
    setError(null);
    try {
      // One click, both server-side checks: the preview creates the exact
      // short-lived approval and the execute consumes it (the layout card's
      // flow). An approval kept after an unknown outcome is retried as is.
      let exact = approval;
      if (!exact) {
        const preview = await requestAction(proposal.draftId, {
          action: "preview",
          expectedDraftVersion: 0,
          idempotencyKey: crypto.randomUUID(),
        });
        exact = preview.approval ?? null;
        if (!exact) throw new Error("The safety check returned no approval.");
        setApproval(exact);
        setBusy("execute");
      }
      const response = await requestAction(proposal.draftId, {
        action: "execute",
        approvalId: exact.id,
      });
      if (!response.result)
        throw new Error("The apply response was incomplete.");
      setResult(response.result);
      setApproval(null);
    } catch (thrown) {
      if (
        thrown instanceof ActionRequestError &&
        thrown.outcome === "unknown"
      ) {
        setError(UNKNOWN_OUTCOME);
      } else {
        setApproval(null);
        setError(messageOf(thrown, "Your storefront was not changed."));
      }
    } finally {
      setBusy(null);
    }
  }

  async function publishAll() {
    if (!result) return;
    setPublishing(true);
    setPublishError(null);
    try {
      for (const page of result.approval.pages) {
        const response = await publishPage(page.id);
        if (response.error) throw new Error(`${page.title}: ${response.error}`);
      }
      if (result.approval.chromeChanged) {
        const response = await publishChrome();
        if (response.error) throw new Error(response.error);
      }
      setPublished(true);
    } catch (thrown) {
      setPublishError(messageOf(thrown, "Your pages were not published."));
    } finally {
      setPublishing(false);
    }
  }

  const hiddenCount = proposal.pages.reduce(
    (sum, page) => sum + page.hidden.length,
    0,
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ddd6fe] bg-white shadow-[0_1px_3px_rgba(38,25,77,0.08)]">
      <header className="border-b border-[#ebe7f7] bg-[#fbfaff] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#6d4dff] text-white">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-[#27242d]">
                {proposal.title}
              </h3>
              <p className="mt-0.5 text-[9px] text-[#716d78]">
                Private until you apply it
              </p>
            </div>
          </div>
          <MinkLink
            href="/dashboard/builder"
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[9px] font-semibold text-[#5d3fe3] hover:underline"
          >
            Open Builder <ExternalLink className="h-3 w-3" />
          </MinkLink>
        </div>
      </header>

      <div className="space-y-3 p-3">
        <div className="flex flex-wrap gap-1.5 text-[9px]">
          <Badge>
            {proposal.pages.length} page{proposal.pages.length === 1 ? "" : "s"}
          </Badge>
          <Badge>
            {proposal.photos.length} new photo
            {proposal.photos.length === 1 ? "" : "s"}
          </Badge>
          {proposal.design ? <Badge>New look</Badge> : null}
          {hiddenCount ? (
            <Badge>{hiddenCount} sample sections off</Badge>
          ) : null}
        </div>
        <p className="text-[11px] leading-5 text-[#39363f]">
          {proposal.explanation}
        </p>

        {proposal.photos.length ? (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold text-[#4a4260]">
              <Images className="h-3 w-3" /> New photos
            </p>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {proposal.photos.map((photo) => (
                <figure key={photo.url} className="w-32 shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo.url}
                    alt={photo.alt}
                    loading="lazy"
                    className="h-20 w-32 rounded-lg border border-[#e7e3ef] bg-[#f4f2fa] object-cover"
                  />
                  <figcaption className="mt-1 line-clamp-2 text-[8px] leading-3 text-[#716d78]">
                    {photo.where}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        ) : null}

        <details className="rounded-xl border border-[#e7e3ef] bg-[#fbfaff] px-3 py-2.5">
          <summary className="cursor-pointer text-[10px] font-semibold text-[#4a4260]">
            Review every change
          </summary>
          <div className="mt-2 space-y-2">
            <ul className="space-y-1.5">
              {proposal.pages.map((page) => (
                <li
                  key={page.slug}
                  className="rounded-xl border border-[#e7e3ef] bg-white p-2.5 text-[9px] leading-4 text-[#54505c]"
                >
                  <p className="font-semibold text-[#403753]">{page.title}</p>
                  <p>
                    {page.textChanges} text change
                    {page.textChanges === 1 ? "" : "s"}
                    {page.photoChanges
                      ? `, ${page.photoChanges} new photo${page.photoChanges === 1 ? "" : "s"}`
                      : ""}
                  </p>
                  {page.hidden.length ? (
                    <ul className="mt-1 space-y-0.5">
                      {page.hidden.map((entry, index) => (
                        <li key={index} className="flex gap-1.5">
                          <EyeOff className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>
                            <strong className="font-semibold">
                              {SECTION_TYPE_META[
                                entry.type as keyof typeof SECTION_TYPE_META
                              ]?.label ?? entry.type}{" "}
                              switched off:
                            </strong>{" "}
                            {entry.reason}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>

            {proposal.design ? (
              <>
                <PaletteChanges palette={proposal.design.palette} />
                <TypeChanges
                  fonts={proposal.design.fonts}
                  shape={proposal.design.shape}
                />
              </>
            ) : null}

            {proposal.chrome.length ? (
              <Group title="Header, footer and store description">
                {proposal.chrome.map((entry) => (
                  <li key={entry.label}>
                    <span className="font-semibold">{entry.label}:</span>{" "}
                    <span className="text-[#8a8490] line-through">
                      {entry.before || "empty"}
                    </span>{" "}
                    → {entry.after}
                  </li>
                ))}
              </Group>
            ) : null}

            {proposal.categories.length ? (
              <Group
                title="Categories (live at once)"
                icon={<Tags className="h-3 w-3" />}
              >
                {proposal.categories.map((change, index) => (
                  <li key={index} className="flex items-start gap-2">
                    {change.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={change.photoUrl}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded border border-[#e7e3ef] object-cover"
                      />
                    ) : null}
                    <span>
                      {change.action === "create"
                        ? `New: ${change.name}`
                        : change.action === "hide"
                          ? `Hidden: ${change.name}`
                          : change.previousName
                            ? `${change.previousName} → ${change.name}`
                            : change.name}
                      {change.description ? (
                        <span className="block text-[#716d78]">
                          {change.description}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </Group>
            ) : null}

            {proposal.products.length ? (
              <Group
                title="Theme samples taken off the shop (live at once)"
                icon={<PackageX className="h-3 w-3" />}
              >
                {proposal.products.map((product) => (
                  <li key={product.name}>{product.name}</li>
                ))}
              </Group>
            ) : null}
          </div>
        </details>

        {proposal.skipped.length ? (
          <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[9px] leading-4 text-amber-900">
            <summary className="cursor-pointer font-semibold">
              Not done this time ({proposal.skipped.length})
            </summary>
            <ul className="mt-1.5 space-y-1">
              {proposal.skipped.map((note, index) => (
                <li key={index}>
                  <span className="font-semibold">{note.label}:</span>{" "}
                  {note.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {result ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-4 text-emerald-900">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">
                  Saved to your Website Builder draft
                </p>
                <p className="mt-1">
                  {published
                    ? "Your new pages are live."
                    : "Preview it in Website Builder, then publish when you are happy."}
                </p>
                <MinkLink
                  href="/dashboard/builder"
                  className="mt-2 inline-flex items-center gap-1 font-semibold text-emerald-800 underline"
                >
                  Preview in Website Builder{" "}
                  <ExternalLink className="h-3 w-3" />
                </MinkLink>
              </div>
            </div>
            {published ? null : (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-200 pt-3">
                <p className="max-w-lg">
                  <span className="font-semibold">Ready to go live?</span>{" "}
                  Publishing puts each changed page&rsquo;s whole draft on your
                  storefront, including any other unpublished edits.
                </p>
                <button
                  type="button"
                  disabled={publishing}
                  onClick={() => void publishAll()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-[9px] font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {publishing ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Globe className="h-3.5 w-3.5" />
                  )}
                  {publishing ? "Publishing…" : "Publish these pages"}
                </button>
              </div>
            )}
            {publishError ? (
              <p className="mt-2 flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-800">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {publishError} Your draft is safe; publish it from Website
                  Builder.
                </span>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2 rounded-xl border border-[#ded8f4] bg-[#faf8ff] p-3">
            {proposal.live.length ? (
              <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[9px] leading-4 text-amber-900">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Applying also changes these on your live store at once:{" "}
                  {proposal.live.join("; ")}. Everything else waits in your
                  Website Builder draft until you publish.
                </span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="max-w-lg text-[9px] leading-4 text-[#5f5969]">
                <p className="font-semibold text-[#403753]">
                  Apply this to your Website Builder draft
                </p>
                <p>Pages are not published until you choose to.</p>
                {approval ? (
                  <p className="mt-1 text-amber-800">
                    The last apply could not be confirmed. Retry is safe and
                    cannot apply twice.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void apply()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#5d3fe3] px-3 py-1.5 text-[9px] font-semibold text-white hover:bg-[#4e32ca] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                {busy
                  ? "Applying…"
                  : approval
                    ? "Retry applying"
                    : "Apply to Website Builder draft"}
              </button>
            </div>
          </div>
        )}

        {error ? (
          <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : null}

        <details className="rounded-xl border border-[#eeeaf8] bg-[#fbfaff] px-3 py-2">
          <summary className="cursor-pointer text-[9px] font-semibold text-[#4a4260]">
            Integrity details
          </summary>
          <p className="mt-2 break-all font-mono text-[8px] text-[#8a8490]">
            Plan SHA-256: {proposal.planDigest}
          </p>
        </details>
      </div>
    </section>
  );
}

function Group({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#e7e3ef] bg-[#f8f7fa] p-2.5 text-[9px] leading-4 text-[#54505c]">
      <p className="flex items-center gap-1.5 font-semibold">
        {icon}
        {title}
      </p>
      <ul className="mt-1.5 space-y-1">{children}</ul>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#ddd6fe] bg-[#f8f5ff] px-2 py-1 font-medium text-[#564a70]">
      {children}
    </span>
  );
}

const UNKNOWN_OUTCOME =
  "We could not confirm whether your storefront changed. Check Website Builder, or retry; it can't apply twice.";

class ActionRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "unknown",
  ) {
    super(message);
  }
}

type Mutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string };

async function requestAction(
  draftId: string,
  body: Mutation,
): Promise<{
  approval?: MinkStorefrontPersonalizationActionApproval;
  result?: MinkStorefrontPersonalizationActionResult;
}> {
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
    throw new ActionRequestError(UNKNOWN_OUTCOME, "unknown");
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    approval?: MinkStorefrontPersonalizationActionApproval;
    result?: MinkStorefrontPersonalizationActionResult;
  } | null;
  if (!response.ok) {
    throw new ActionRequestError(
      payload?.error ?? "This personalisation could not be applied.",
      response.status >= 500 ? "unknown" : "rejected",
    );
  }
  return payload ?? {};
}

async function readLatestAction(
  draftId: string,
  signal: AbortSignal,
): Promise<MinkStorefrontPersonalizationActionResult | null> {
  const response = await fetch(
    `/api/mink/drafts/${encodeURIComponent(draftId)}/personalization-action`,
    { cache: "no-store", signal },
  );
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    result?: MinkStorefrontPersonalizationActionResult | null;
  } | null;
  return payload?.result ?? null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
