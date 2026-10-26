import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Boxes,
  ChartNoAxesCombined,
  CircleHelp,
  MapPin,
  PackageSearch,
  PanelsTopLeft,
} from "lucide-react";
import { useId, type MouseEvent as ReactMouseEvent } from "react";
import {
  MINK_PREFILL_LABELS,
  minkPrefillPath,
  storeMinkPrefill,
} from "@/lib/mink/form-prefill";
import { useChat } from "./chat-context";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkProductImportCard } from "./mink-product-import-card";
import { MinkProposalCard } from "./mink-proposal-card";
import { MinkStorefrontCodeProposalCard } from "./mink-storefront-code-proposal-card";
import { MinkStorefrontDesignProposalCard } from "./mink-storefront-design-proposal-card";
import { MinkMediaProposalCard } from "./mink-media-proposal-card";
import { MinkStorefrontLayoutProposalCard } from "./mink-storefront-layout-proposal-card";
import { MinkStorefrontPersonalizationCard } from "./mink-storefront-personalization-card";
import { MinkRevampCard } from "./mink-revamp-card";
import { MinkWorkflowCard } from "./mink-workflow-card";
import { MinkBuilderProposalCard } from "./mink-builder-proposal-card";
import { MinkLink } from "./mink-link";
import { MinkChartCard } from "./mink-chart";

/**
 * The DOM id of a storefront redesign's card, so a later mention of the same
 * redesign can scroll back to it. Only one chat surface (the side panel or
 * the full view) renders at a time, so the id is unique on the page.
 */
export function revampCardElementId(revampId: string): string {
  return `revamp-card-${revampId}`;
}

/** Scrolls to a redesign's card and moves focus onto it. */
function showRevampCard(revampId: string) {
  const card = document.getElementById(revampCardElementId(revampId));
  if (!card) return;
  const still =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView?.({
    block: "start",
    behavior: still ? "auto" : "smooth",
  });
  card.focus({ preventScroll: true });
}

/**
 * A later mention of a redesign whose card the thread already shows (owner's
 * words, 25 Oct 2026): one line, and a button that goes to that card.
 */
function RevampCardPointer({ revampId }: { revampId: string }) {
  const lineId = useId();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#ded8f4] bg-[#fcfbff] px-3 py-2">
      <p id={lineId} className="text-xs leading-5 text-[#29272d]">
        Your storefront redesign card is above.
      </p>
      <button
        type="button"
        aria-describedby={lineId}
        onClick={() => showRevampCard(revampId)}
        className="inline-flex items-center gap-1 rounded-full border border-[#ded8f4] bg-white px-3 py-1.5 text-xs font-semibold text-[#5b3fd0] transition-colors hover:bg-[#f3f0fb] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] pointer-coarse:min-h-11"
      >
        <ArrowUp className="h-3 w-3" aria-hidden="true" />
        Show it
      </button>
    </div>
  );
}

export function MinkArtifacts({
  artifacts,
  onPrompt,
  promptDisabled = false,
  shownRevampIds,
}: {
  artifacts: MinkArtifact[];
  onPrompt?: (prompt: string) => void;
  promptDisabled?: boolean;
  /**
   * Storefront redesigns whose card an earlier message in the thread already
   * shows (`revampIdsShownBefore` in dashboard-chat.tsx).
   */
  shownRevampIds?: ReadonlySet<string>;
}) {
  if (!artifacts.length) return null;
  // ★★ ONE CARD PER REDESIGN IN A THREAD (owner's decision, 25 Oct 2026).
  // The card polls its job and carries Apply, Publish and Undo, so a second
  // copy is a second set of buttons for one redesign: Apply pressed on one,
  // and the other still offers it. A repeat (in a later answer, or twice in
  // one) is a line pointing back to the first. Local to this render, so the
  // check covers repeats inside this message too.
  const seenRevamps = new Set(shownRevampIds ?? []);
  return (
    <div className="mt-2 space-y-2">
      {artifacts.map((artifact, index) => {
        if (artifact.type === "builder_proposal")
          return (
            <MinkBuilderProposalCard
              key={artifact.draftId}
              proposal={artifact}
              onPrompt={onPrompt}
              promptDisabled={promptDisabled}
            />
          );
        if (artifact.type === "product_import")
          return (
            <MinkProductImportCard
              key={`${artifact.type}-${artifact.fileId}`}
              artifact={artifact}
              onPrompt={onPrompt}
              promptDisabled={promptDisabled}
            />
          );
        if (artifact.type === "navigation") {
          return (
            <NavigationArtifact
              key={`${artifact.type}-${artifact.path}-${index}`}
              artifact={artifact}
            />
          );
        }
        if (artifact.type === "chart") {
          return (
            <MinkChartCard
              key={`${artifact.type}-${index}`}
              artifact={artifact}
            />
          );
        }
        if (artifact.type === "clarification") {
          return (
            <ClarificationArtifact
              key={`${artifact.type}-${index}`}
              artifact={artifact}
              onPrompt={onPrompt}
              disabled={promptDisabled}
            />
          );
        }
        if (artifact.type === "metrics") {
          return (
            <MetricArtifact
              key={`${artifact.type}-${index}`}
              artifact={artifact}
            />
          );
        }
        if (artifact.type === "records") {
          return (
            <RecordArtifact
              key={`${artifact.type}-${index}`}
              artifact={artifact}
            />
          );
        }
        if (artifact.type === "catalog") {
          return (
            <CatalogArtifact
              key={`${artifact.type}-${index}`}
              artifact={artifact}
              onPrompt={onPrompt}
              promptDisabled={promptDisabled}
            />
          );
        }
        if (artifact.type === "proposal") {
          return (
            <MinkProposalCard
              key={`${artifact.type}-${artifact.draftId}`}
              proposal={artifact}
            />
          );
        }
        if (artifact.type === "storefront_code_proposal") {
          return (
            <MinkStorefrontCodeProposalCard
              key={`${artifact.type}-${artifact.draftId}`}
              proposal={artifact}
            />
          );
        }
        if (artifact.type === "storefront_layout_proposal") {
          return (
            <MinkStorefrontLayoutProposalCard
              key={`${artifact.type}-${artifact.draftId}`}
              proposal={artifact}
            />
          );
        }
        if (artifact.type === "storefront_personalization_proposal") {
          return (
            <MinkStorefrontPersonalizationCard
              key={`${artifact.type}-${artifact.draftId}`}
              proposal={artifact}
            />
          );
        }
        if (artifact.type === "storefront_revamp") {
          if (seenRevamps.has(artifact.revampId)) {
            return (
              <RevampCardPointer
                key={`${artifact.type}-${artifact.revampId}-again-${index}`}
                revampId={artifact.revampId}
              />
            );
          }
          seenRevamps.add(artifact.revampId);
          return (
            <div
              key={`${artifact.type}-${artifact.revampId}`}
              id={revampCardElementId(artifact.revampId)}
              tabIndex={-1}
              className="scroll-mt-4 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[#6d4dff] focus-visible:ring-offset-2"
            >
              <MinkRevampCard artifact={artifact} />
            </div>
          );
        }
        if (artifact.type === "storefront_design_proposal") {
          return (
            <MinkStorefrontDesignProposalCard
              key={`${artifact.type}-${artifact.draftId}`}
              proposal={artifact}
            />
          );
        }
        if (artifact.type === "media_image_proposal") {
          return (
            <MinkMediaProposalCard
              key={`${artifact.type}-${artifact.draftId}`}
              proposal={artifact}
            />
          );
        }
        if (artifact.type === "workflow") {
          return (
            <MinkWorkflowCard
              key={`${artifact.type}-${artifact.runId}`}
              artifact={artifact}
            />
          );
        }
        return (
          <SourceArtifact
            key={`${artifact.type}-${index}`}
            artifact={artifact}
          />
        );
      })}
    </div>
  );
}

/** Where a navigation card goes: the prefilled form, or the page itself. */
export function minkNavigationHref(
  artifact: Extract<MinkArtifact, { type: "navigation" }>,
) {
  if (artifact.prefill) return minkPrefillPath(artifact.prefill.kind);
  return safeHref(artifact.path) ? artifact.path : "/dashboard";
}

function isPlainClick(event: ReactMouseEvent) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * A page Mink found for the merchant, opened only when they click it.
 *
 * ★★ IT NEVER OPENS BY ITSELF. The panel used to navigate the moment the
 * answer arrived, and on a phone that also closed the chat, so asking "where
 * do I add a product?" swept the merchant off the conversation mid-read.
 * ChatGPT, Claude and Sidekick all put the link in the answer and leave the
 * tap to the person. It is a real dashboard link (MinkLink), so the chat
 * surface's capture-phase rule collapses the full view or closes the phone
 * panel exactly as it does for any other link in an answer, and a new-tab
 * click works as one.
 *
 * ★ A prefill is written to session storage as the click happens, before the
 * client navigation, where the form reads and clears it on first render; the
 * spotlight is asked for only on a plain click, since a new tab leaves this
 * page where the control is not.
 */
function NavigationArtifact({
  artifact,
}: {
  artifact: Extract<MinkArtifact, { type: "navigation" }>;
}) {
  const { showSpotlight } = useChat();
  return (
    <section className="overflow-hidden rounded-2xl border border-[#ded8f4] bg-[#fcfbff] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <ArtifactHeader
        title={artifact.title}
        icon={<PanelsTopLeft className="h-3.5 w-3.5" />}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 p-3">
        <p className="text-xs leading-5 text-[#29272d]">
          {artifact.prefill
            ? `Opens ${MINK_PREFILL_LABELS[artifact.prefill.kind]} with ${describePrefill(artifact.prefill.fields)} filled in, for you to review and save.`
            : artifact.highlight
              ? `Opens the page and points out ${artifact.highlight.label}.`
              : "Opens the page. This chat is here when you come back."}
        </p>
        <MinkLink
          href={minkNavigationHref(artifact)}
          onClick={(event) => {
            if (artifact.prefill) storeMinkPrefill(artifact.prefill);
            if (isPlainClick(event)) showSpotlight(artifact.highlight ?? null);
          }}
          className="inline-flex items-center gap-1 rounded-full bg-[#6d4dff] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#5b3fd0]"
        >
          {artifact.label}
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </MinkLink>
      </div>
    </section>
  );
}

const PREFILL_FIELD_WORDS: Record<string, string> = {
  name: "the name",
  title: "the title",
  description: "a description",
  excerpt: "an excerpt",
  body: "the text",
  seoTitle: "SEO text",
  seoDescription: "SEO text",
  basePrice: "prices",
  sellingPrice: "prices",
  rewardType: "the reward",
  rewardValue: "the reward",
  minSubtotal: "a minimum order",
  delivery: "how it applies",
  code: "the code",
  budget: "a budget",
  validUntil: "an end date",
  slug: "the URL",
  status: "visibility",
  category: "a category",
  tags: "tags",
  mode: "the rate mode",
  flatRate: "the flat rate",
  freeAbove: "the free-delivery threshold",
  manualMinDays: "delivery days",
  manualMaxDays: "delivery days",
  handlingDays: "handling time",
};

function describePrefill(fields: object) {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(
    fields as Record<string, unknown>,
  )) {
    if (value === undefined) continue;
    const word = PREFILL_FIELD_WORDS[key];
    if (word && !parts.includes(word)) parts.push(word);
  }
  if (parts.length === 0) return "some details";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function ClarificationArtifact({
  artifact,
  onPrompt,
  disabled,
}: {
  artifact: Extract<MinkArtifact, { type: "clarification" }>;
  onPrompt?: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[#ded8f4] bg-[#fcfbff] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <ArtifactHeader
        title={artifact.title}
        icon={<CircleHelp className="h-3.5 w-3.5" />}
      />
      <div className="p-3">
        <p className="text-xs font-medium leading-5 text-[#29272d]">
          {artifact.question}
        </p>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {artifact.choices.map((choice) => (
            <button
              key={`${choice.label}-${choice.prompt}`}
              type="button"
              disabled={disabled || !onPrompt}
              onClick={() => onPrompt?.(choice.prompt)}
              className="rounded-xl border border-[#ded8f4] bg-white px-3 py-2 text-left transition-colors hover:border-[#b9a9f4] hover:bg-[#f8f5ff] disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="block text-[11px] font-semibold text-[#3f2a7c]">
                {choice.label}
              </span>
              {choice.description ? (
                <span className="mt-0.5 block text-[9px] leading-3.5 text-[#74707d]">
                  {choice.description}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function CatalogArtifact({
  artifact,
  onPrompt,
  promptDisabled,
}: {
  artifact: Extract<MinkArtifact, { type: "catalog" }>;
  onPrompt?: (prompt: string) => void;
  promptDisabled: boolean;
}) {
  const publicationCounts = [
    ["Products", artifact.counts.total],
    ["Published", artifact.counts.published],
    ["Unpublished", artifact.counts.unpublished],
    ["Draft", artifact.counts.draft],
    ["Archived", artifact.counts.archived],
  ] as const;
  const stockCounts = [
    ["Low-stock SKUs", artifact.counts.lowStock, "low"],
    ["Out-of-stock SKUs", artifact.counts.outOfStock, "out"],
  ] as const;

  return (
    <section className="overflow-hidden rounded-2xl border border-[#e5e2ec] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <ArtifactHeader
        title={artifact.title}
        icon={<PackageSearch className="h-3.5 w-3.5" />}
        href={artifact.dashboardPath}
      />
      <div className="p-3">
        <Filters filters={artifact.filters} />
        <div className="grid grid-cols-3 gap-1.5">
          {publicationCounts.map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border border-[#efedf2] bg-[#fafafa] px-2.5 py-2"
            >
              <div className="text-[9px] font-medium leading-3 text-[#777b82]">
                {label}
              </div>
              <div className="mt-0.5 text-base font-semibold tabular-nums text-[#18181b]">
                {value.toLocaleString("en-IN")}
              </div>
            </div>
          ))}
        </div>
        {artifact.locations?.length ? (
          <div className="mt-3">
            <h4 className="mb-1.5 text-[11px] font-semibold text-[#29272d]">
              Inventory by location
            </h4>
            <div className="space-y-1.5">
              {artifact.locations.map((location) => (
                <div
                  key={location.id}
                  className="rounded-xl border border-[#ece9f2] bg-[#fafafa] px-2.5 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[11px] font-semibold text-[#29272d]">
                        <MapPin className="h-3 w-3 shrink-0 text-[#6d4dff]" />
                        <span className="truncate">{location.name}</span>
                      </div>
                      <div className="mt-0.5 text-[9px] capitalize text-[#777b82]">
                        {location.type.replaceAll("_", " ")} ·{" "}
                        {location.trackedItems.toLocaleString("en-IN")} tracked
                        SKUs
                      </div>
                    </div>
                    {safeHref(location.dashboardPath) ? (
                      <MinkLink
                        href={location.dashboardPath}
                        className="shrink-0 text-[9px] font-medium text-[#5b3fd0] hover:underline"
                      >
                        Open inventory
                      </MinkLink>
                    ) : null}
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    <div className="rounded-lg border border-amber-100 bg-amber-50/70 px-2 py-1.5">
                      <div className="text-[8px] font-medium text-[#777b82]">
                        Low stock
                      </div>
                      <div className="text-sm font-semibold tabular-nums text-[#29272d]">
                        {location.lowStock.toLocaleString("en-IN")}
                      </div>
                    </div>
                    <div className="rounded-lg border border-rose-100 bg-rose-50/70 px-2 py-1.5">
                      <div className="text-[8px] font-medium text-[#777b82]">
                        Out of stock
                      </div>
                      <div className="text-sm font-semibold tabular-nums text-[#29272d]">
                        {location.outOfStock.toLocaleString("en-IN")}
                      </div>
                    </div>
                  </div>
                  {onPrompt ? (
                    <button
                      type="button"
                      disabled={promptDisabled}
                      onClick={() => onPrompt(location.prompt)}
                      className="mt-1.5 text-[9px] font-semibold text-[#5b3fd0] hover:underline disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      List this location&apos;s SKUs
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {artifact.locationsTruncated ? (
              <div className="mt-2 text-[10px] leading-4 text-[#7b7f86]">
                Showing the first 20 accessible locations. Name another exact
                dashboard location to inspect it.
              </div>
            ) : null}
          </div>
        ) : artifact.counts.inventoryItems != null ? (
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {stockCounts.map(([label, value, tone]) => (
              <div
                key={label}
                className={`rounded-xl border px-2.5 py-2 ${
                  tone === "out"
                    ? "border-rose-100 bg-rose-50/70"
                    : "border-amber-100 bg-amber-50/70"
                }`}
              >
                <div className="text-[9px] font-medium leading-3 text-[#777b82]">
                  {label}
                </div>
                <div className="mt-0.5 text-base font-semibold tabular-nums text-[#18181b]">
                  {value?.toLocaleString("en-IN")}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!artifact.locations?.length ? (
          <>
            <div className="mt-4 flex items-center justify-between gap-3">
              <h4 className="text-[11px] font-semibold text-[#29272d]">
                Products &amp; variants
              </h4>
              {safeHref(artifact.inventoryDashboardPath) ? (
                <MinkLink
                  href={artifact.inventoryDashboardPath}
                  className="text-[10px] font-medium text-[#5b3fd0] hover:underline"
                >
                  Open inventory
                </MinkLink>
              ) : null}
            </div>
            <div className="mt-1 divide-y divide-[#eeeeef]">
              {artifact.items.map((item) => (
                <div key={item.id} className="py-2.5 first:pt-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {safeHref(item.dashboardPath) ? (
                        <MinkLink
                          href={item.dashboardPath}
                          className="block truncate text-xs font-semibold text-[#29272d] hover:text-[#5b3fd0] hover:underline"
                        >
                          {item.title}
                        </MinkLink>
                      ) : (
                        <div className="truncate text-xs font-semibold text-[#29272d]">
                          {item.title}
                        </div>
                      )}
                      <div className="mt-0.5 truncate text-[10px] text-[#777b82]">
                        {[item.variant, item.sku].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {item.stock != null &&
                    item.inventoryStatus !== "untracked" ? (
                      <div className="shrink-0 text-right">
                        <div className="text-xs font-semibold tabular-nums text-[#29272d]">
                          {item.stock.toLocaleString("en-IN")}
                        </div>
                        <div className="text-[9px] text-[#8c9196]">
                          in stock
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {item.publicationTags.map((tag) => (
                      <StatusTag key={tag} status={tag} />
                    ))}
                    {item.inventoryStatus ? (
                      <StatusTag status={item.inventoryStatus} />
                    ) : null}
                    {item.inventoryStatus === "low" &&
                    item.threshold != null ? (
                      <span className="rounded-full bg-[#f4f4f5] px-2 py-0.5 text-[9px] font-medium text-[#69696f]">
                        Threshold {item.threshold.toLocaleString("en-IN")}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
              {!artifact.items.length ? (
                <div className="py-3 text-xs text-[#7b7f86]">
                  No matching products or variants.
                </div>
              ) : null}
            </div>
            {artifact.truncated ? (
              <div className="mt-2 text-[10px] leading-4 text-[#7b7f86]">
                Showing the first bounded set, with stock exceptions first. Open
                Products or Inventory for the full catalogue.
              </div>
            ) : null}
          </>
        ) : null}
        <DataAsOf value={artifact.dataAsOf} />
      </div>
    </section>
  );
}

function StatusTag({ status }: { status: string }) {
  const normalized = status.toLocaleLowerCase("en-IN");
  const label: Record<string, string> = {
    in: "In stock",
    low: "Low stock",
    out: "Out of stock",
    untracked: "Not tracked",
  };
  const tone =
    normalized === "out"
      ? "bg-rose-50 text-rose-700 ring-rose-100"
      : normalized === "low" || normalized === "draft"
        ? "bg-amber-50 text-amber-700 ring-amber-100"
        : normalized === "published" || normalized === "in"
          ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
          : "bg-[#f4f4f5] text-[#69696f] ring-[#e7e7e9]";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[9px] font-medium capitalize ring-1 ring-inset ${tone}`}
    >
      {label[normalized] ?? normalized.replaceAll("_", " ")}
    </span>
  );
}

function Filters({
  filters,
}: {
  filters: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {filters
        .filter((filter) => filter.value)
        .map((filter) => (
          <span
            key={`${filter.label}-${filter.value}`}
            className="rounded-full border border-[#ded8f4] bg-[#faf8ff] px-2 py-1 text-[10px] text-[#5e5179]"
          >
            <span className="font-semibold">{filter.label}:</span>{" "}
            {filter.value}
          </span>
        ))}
    </div>
  );
}

function MetricArtifact({
  artifact,
}: {
  artifact: Extract<MinkArtifact, { type: "metrics" }>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#e4e0ef] bg-white shadow-sm">
      <ArtifactHeader
        title={artifact.title}
        icon={<ChartNoAxesCombined className="h-3.5 w-3.5" />}
        href={artifact.dashboardPath}
      />
      <div className="p-3">
        <Filters filters={artifact.filters} />
        <div className="grid grid-cols-2 gap-2">
          {artifact.metrics.map((metric) => (
            <div key={metric.label} className="rounded-lg bg-[#f7f7f8] p-2.5">
              <div className="text-[10px] font-medium text-[#6d7175]">
                {metric.label}
              </div>
              <div className="mt-0.5 text-base font-semibold text-[#1a1a1a]">
                {formatMetric(metric.value, metric.format, artifact.currency)}
              </div>
              {metric.trendPercent != null ? (
                <div
                  className={`text-[10px] ${metric.trendPercent >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                >
                  {metric.trendPercent >= 0 ? "+" : ""}
                  {metric.trendPercent}% comparison
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <DataAsOf value={artifact.dataAsOf} />
      </div>
    </section>
  );
}

function RecordArtifact({
  artifact,
}: {
  artifact: Extract<MinkArtifact, { type: "records" }>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#e4e0ef] bg-white shadow-sm">
      <ArtifactHeader
        title={artifact.title}
        icon={
          artifact.recordType === "storefront" ? (
            <PanelsTopLeft className="h-3.5 w-3.5" />
          ) : artifact.recordType === "blog" ? (
            <BookOpen className="h-3.5 w-3.5" />
          ) : (
            <Boxes className="h-3.5 w-3.5" />
          )
        }
        href={artifact.dashboardPath}
      />
      <div className="p-3">
        <Filters filters={artifact.filters} />
        <div className="divide-y divide-[#eeeeef]">
          {artifact.records.slice(0, 10).map((record) => (
            <div
              key={`${artifact.recordType}-${record.id}`}
              className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                {safeHref(record.dashboardPath) ? (
                  <MinkLink
                    href={record.dashboardPath}
                    className="block truncate text-xs font-semibold text-[#2f2460] hover:underline"
                  >
                    {record.title}
                  </MinkLink>
                ) : (
                  <div className="truncate text-xs font-semibold text-[#2f2460]">
                    {record.title}
                  </div>
                )}
                {record.subtitle ? (
                  <div className="truncate text-[10px] text-[#7b7f86]">
                    {record.subtitle}
                  </div>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                {record.value ? (
                  <div className="text-xs font-semibold text-[#1a1a1a]">
                    {record.value}
                  </div>
                ) : null}
                {record.status ? (
                  <div className="text-[10px] capitalize text-[#7b7f86]">
                    {record.status.replaceAll("_", " ")}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {!artifact.records.length ? (
            <div className="py-3 text-xs text-[#7b7f86]">
              No matching records.
            </div>
          ) : null}
        </div>
        {artifact.truncated ? (
          <div className="mt-2 text-[10px] text-[#7b7f86]">
            {artifact.recordType === "inventory"
              ? "Showing the lowest-stock matches. Open the dashboard for the full list."
              : "Showing a bounded result set. Open the dashboard for the full list."}
          </div>
        ) : null}
        <DataAsOf value={artifact.dataAsOf} />
      </div>
    </section>
  );
}

function SourceArtifact({
  artifact,
}: {
  artifact: Extract<MinkArtifact, { type: "sources" }>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#e4e0ef] bg-white shadow-sm">
      <ArtifactHeader
        title={artifact.title}
        icon={<BookOpen className="h-3.5 w-3.5" />}
      />
      <div className="divide-y divide-[#eeeeef] px-3">
        {artifact.sources.map((source) => (
          <MinkLink
            key={source.url}
            href={safeHref(source.url) ? source.url : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="block py-2.5 first:pt-3 last:pb-3 hover:bg-[#fbfaff]"
          >
            <div className="flex items-start justify-between gap-2 text-xs font-semibold text-[#2f2460]">
              {source.title}
              <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0" />
            </div>
            {source.excerpt ? (
              <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-[#7b7f86]">
                {source.excerpt}
              </div>
            ) : null}
          </MinkLink>
        ))}
      </div>
    </section>
  );
}

function ArtifactHeader({
  title,
  icon,
  href,
}: {
  title: string;
  icon: React.ReactNode;
  href?: string;
}) {
  return (
    <header className="flex items-center justify-between border-b border-[#eeeeef] bg-[#fbfaff] px-3 py-2 text-xs font-semibold text-[#3e3262]">
      <span className="flex items-center gap-1.5">
        {icon}
        {title}
      </span>
      {safeHref(href) ? (
        <MinkLink
          href={href}
          className="rounded p-1 hover:bg-[#eee9ff]"
          aria-label={`Open ${title}`}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </MinkLink>
      ) : null}
    </header>
  );
}

function formatMetric(
  value: number,
  format: "number" | "currency" | "percent",
  currency = "INR",
) {
  if (format === "currency") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (format === "percent") return `${value.toLocaleString("en-IN")}%`;
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function DataAsOf({ value }: { value?: string }) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <div className="mt-2 text-right text-[9px] text-[#9a9da3]">
      Data as of{" "}
      {date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}{" "}
      IST
    </div>
  );
}

function safeHref(value: string | undefined): value is string {
  if (!value) return false;
  if (
    (value === "/dashboard" ||
      value.startsWith("/dashboard/") ||
      value.startsWith("/dashboard?") ||
      value.startsWith("/dashboard#")) &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u001F\u007F]/.test(value)
  )
    return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "help.storemink.com" ||
        (url.hostname.startsWith("help.") &&
          url.hostname.endsWith(".storemink.com")))
    );
  } catch {
    return false;
  }
}
