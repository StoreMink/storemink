"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Loader2, Save, X } from "lucide-react";
import { toast } from "sonner";
import { replaceThemeStudioSlotImagesAction } from "@/app/actions/theme-studio-actions";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import { InfoTip } from "@/components/ui/info-tip";
import {
  THEME_IMAGE_PROBLEM_LABEL,
  redrawEstimate,
  type SlotDrawHistory,
} from "@/lib/theme-studio/image-history";
import type { ThemeStudioSlotView } from "@/lib/theme-studio/slot-images";
import { plainText } from "../../../../studio-ui";
import { designLabel } from "../../../../studio-words";
import { useStudioPage } from "../../../studio-tabs";
import { RedrawPicturesButton } from "./generate-images-button";
import { pictureName } from "./picture-names";

// ---------------------------------------------------------------------------
// The picture editor of the theme page's Pictures tab (wave TS-2, builder
// 2C; plan section 4, "Controls that keep a home").
//
// Uploads go straight to the slot-image route, which crops and stores them
// without changing any design; they are STAGED here with their description
// and where they came from, and saved together as ONE new design. Nothing
// here decides validity: the server checks every field again.
//
// Each picture also says what the image model is asked to draw for it and
// how its current picture came to be (the picture check's verdict). A
// placeholder or a drawn picture can be ticked for a Redraw: a run of just
// those pictures, matched to the theme's existing art direction, started
// with one click and a small confirm that names how many. An uploaded
// picture is never offered: it is the operator's to replace.
//
// ★ WORDS. A design is "Design N"; costs are in the Log tab and in the
// Redraw confirm only; the dashboard's tokens only.
// ---------------------------------------------------------------------------

type Source = "operator-owned" | "licensed";

interface Staged {
  assetId: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  alt: string;
  source: Source;
  licenseNote: string;
}

const SOURCE_LABEL: Record<string, string> = {
  generated: "Drawn by Theme Studio",
  "operator-owned": "Ours",
  licensed: "Licensed",
  "legacy-bundled": "From a bundled theme",
};

function ratio(width: number | null, height: number | null): string {
  if (!width || !height) return "";
  const r = width / height;
  const known: [number, string][] = [
    [1, "1:1"],
    [4 / 3, "4:3"],
    [3 / 4, "3:4"],
    [16 / 10, "16:10"],
    [16 / 9, "16:9"],
    [21 / 9, "21:9"],
    [3 / 2, "3:2"],
    [2 / 3, "2:3"],
    [9 / 19, "9:19"],
  ];
  const match = known.find(([value]) => Math.abs(value - r) / value < 0.02);
  return match ? match[1] : `${r.toFixed(2)}:1`;
}

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function problems(list: SlotDrawHistory["problems"]): string {
  return list.map((p) => THEME_IMAGE_PROBLEM_LABEL[p]).join(", ");
}

/** A provider's reason in words, or nothing when it is only a code. */
function reasonWords(reason: string | null): string {
  if (!reason) return "";
  const plain = plainText(reason).trim();
  return /\s/.test(plain) ? ` (${plain})` : "";
}

/** One line on how a slot's picture came to be, and its tone. */
export function historyLine(history: SlotDrawHistory): {
  text: string;
  tone: "ok" | "warn" | "bad";
} {
  const twice = history.attempts > 1 ? " after a redraw" : "";
  // The reviewer writes whole sentences; the line adds its own full stop.
  const trimmed = plainText(history.note)
    .trim()
    .replace(/[.\s]+$/, "");
  const note = trimmed ? `: ${trimmed}` : "";
  switch (history.status) {
    case "generated":
      if (history.review === "passed") {
        return { text: `Drawn and checked${twice}.`, tone: "ok" };
      }
      if (history.review === "flagged") {
        return {
          text: `Drawn${twice}; kept with ${problems(history.problems)}${note}.`,
          tone: "warn",
        };
      }
      return { text: `Drawn${twice}; not checked yet.`, tone: "warn" };
    case "rejected":
      return {
        text: `Failed its check twice (${problems(history.problems)})${note}. The placeholder was kept.`,
        tone: "bad",
      };
    case "refused":
      return {
        text: `The image model refused it${reasonWords(history.reason)}.`,
        tone: "bad",
      };
    default:
      return {
        text: `Not drawn${reasonWords(history.reason)}.`,
        tone: "bad",
      };
  }
}

export function SlotImagesEditor({
  projectId,
  versionId,
  versionNumber,
  packageDigest,
  revision,
  canEdit,
  blockedReason,
  drawBlockedReason = null,
  slots,
  anchorReusable,
  prices,
}: {
  projectId: string;
  versionId: string;
  versionNumber: number;
  packageDigest: string;
  revision: number;
  canEdit: boolean;
  /** Why nothing can be saved or drawn now; written beside the controls. */
  blockedReason: string | null;
  /** Why pictures can't be drawn now even though they can be saved (the
   * building switch); written under Redraw. */
  drawBlockedReason?: string | null;
  slots: ThemeStudioSlotView[];
  /** A redraw matches the existing art-direction picture instead of drawing
   * one. */
  anchorReusable: boolean;
  /** List prices for the Redraw confirm's estimate; null for the offline
   * test provider. */
  prices: { imageUsd: number; reviewUsd: number } | null;
}) {
  const router = useRouter();
  const page = useStudioPage();
  const [staged, setStaged] = useState<Record<string, Staged>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [onlyPlaceholders, setOnlyPlaceholders] = useState(
    slots.some((slot) => slot.placeholder),
  );
  const [pending, startTransition] = useTransition();
  const [redraw, setRedraw] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  // The licence note typed last, offered for the next picture: most uploads
  // in one sitting come from the same place.
  const lastLicense = useRef<{ source: Source; note: string } | null>(null);
  const design = designLabel(versionNumber);

  const visible = onlyPlaceholders
    ? slots.filter((slot) => slot.placeholder || staged[slot.id])
    : slots;
  const stagedCount = Object.keys(staged).length;
  // Staged uploads, their descriptions and licence notes wait for Save: a
  // reload must not throw them away silently.
  useUnsavedChangesWarning(stagedCount > 0);
  // Package order, so the run's message lists them as the page does.
  const chosen = slots.map((s) => s.id).filter((id) => redraw.has(id));
  const estimate =
    prices && chosen.length > 0
      ? redrawEstimate(chosen.length, anchorReusable, prices)
      : null;

  function toggleRedraw(slotId: string, on: boolean) {
    setRedraw((prev) => {
      const next = new Set(prev);
      if (on) next.add(slotId);
      else next.delete(slotId);
      return next;
    });
  }

  async function upload(slot: ThemeStudioSlotView, file: File) {
    setUploading(slot.id);
    setErrors((prev) => ({ ...prev, [slot.id]: "" }));
    try {
      const url = new URL(
        `/api/platform/theme-studio/projects/${projectId}/slot-images`,
        window.location.origin,
      );
      url.searchParams.set("versionId", versionId);
      url.searchParams.set("slot", slot.id);
      const response = await fetch(url, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        url?: string;
        width?: number;
        height?: number;
        bytes?: number;
        error?: string;
      };
      if (!response.ok || !body.id || !body.url) {
        setErrors((prev) => ({
          ...prev,
          [slot.id]: plainText(
            body.error ?? "The picture couldn't be uploaded.",
          ),
        }));
        return;
      }
      const license = lastLicense.current;
      // An upload replaces the slot; drawing it as well would be two answers.
      toggleRedraw(slot.id, false);
      setStaged((prev) => ({
        ...prev,
        [slot.id]: {
          assetId: body.id!,
          url: body.url!,
          width: body.width ?? 0,
          height: body.height ?? 0,
          bytes: body.bytes ?? 0,
          alt: prev[slot.id]?.alt ?? slot.alt,
          source: prev[slot.id]?.source ?? license?.source ?? "operator-owned",
          licenseNote: prev[slot.id]?.licenseNote ?? license?.note ?? "",
        },
      }));
    } catch {
      setErrors((prev) => ({
        ...prev,
        [slot.id]: "The upload didn't reach the server. Try again.",
      }));
    } finally {
      setUploading(null);
    }
  }

  function update(slotId: string, patch: Partial<Staged>) {
    setStaged((prev) => {
      const current = prev[slotId];
      if (!current) return prev;
      const next = { ...current, ...patch };
      if (patch.licenseNote !== undefined || patch.source !== undefined) {
        lastLicense.current = { source: next.source, note: next.licenseNote };
      }
      return { ...prev, [slotId]: next };
    });
  }

  function unstage(slotId: string) {
    setStaged((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
  }

  function save() {
    setSaveError(null);
    startTransition(async () => {
      try {
        const result = await replaceThemeStudioSlotImagesAction({
          projectId,
          versionId,
          expectedRevision: revision,
          expectedPackageDigest: packageDigest,
          replacements: Object.entries(staged).map(([slotId, image]) => ({
            slotId,
            assetId: image.assetId,
            alt: image.alt,
            source: image.source,
            licenseNote: image.licenseNote,
          })),
        });
        if (!result.ok || !result.id) {
          setSaveError(
            plainText(result.error ?? "The pictures couldn't be saved."),
          );
          return;
        }
        const saved = result.versionNumber
          ? designLabel(result.versionNumber)
          : "a new design";
        setStaged({});
        if (result.checking) {
          // The new design stays hidden while one capture and the design
          // review check it; the theme shows it when they finish.
          toast.success(
            `Saved as ${saved}. Checking it now, about 3 to 5 minutes; you can leave this page.`,
          );
          router.refresh();
          return;
        }
        toast.success(`Saved as ${saved}.`);
        page.openTab("pictures", { versionId: result.id });
      } catch {
        setSaveError(
          "The request failed. Reload the page before trying again.",
        );
      }
    });
  }

  const saveReason = !canEdit
    ? blockedReason
    : stagedCount === 0
      ? "Upload a picture for a slot first; saving makes a new design."
      : uploading
        ? "Wait for the upload to finish."
        : null;
  const redrawReason = !canEdit
    ? blockedReason
    : (drawBlockedReason ??
      (stagedCount > 0
        ? "Save or remove your uploads before redrawing."
        : null));

  return (
    <div className="grid gap-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 rounded-[var(--dash-radius)] border border-[var(--dash-border)] bg-[var(--dash-surface)] px-4 py-3">
        <label className="studio-check-label inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyPlaceholders}
            onChange={(event) => setOnlyPlaceholders(event.target.checked)}
          />
          Show only slots with a placeholder
        </label>
        <div className="flex flex-wrap items-start gap-3">
          {chosen.length > 0 ? (
            <RedrawPicturesButton
              projectId={projectId}
              versionId={versionId}
              versionNumber={versionNumber}
              revision={revision}
              packageDigest={packageDigest}
              slotIds={chosen}
              slotNames={chosen.map(pictureName)}
              estimate={
                estimate
                  ? {
                      images: estimate.images,
                      expectedUsd: estimate.expectedUsd,
                      mostUsd: estimate.mostUsd,
                    }
                  : null
              }
              blockedReason={redrawReason}
            />
          ) : null}
          <span className="studio-action">
            <button
              type="button"
              onClick={save}
              disabled={saveReason !== null || pending}
              className="dash-btn dash-btn-primary"
            >
              {pending ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 studio-spin" />
              ) : (
                <Save aria-hidden="true" className="h-4 w-4" />
              )}
              {stagedCount === 0
                ? "Save as a new design"
                : `Save ${stagedCount} picture${stagedCount === 1 ? "" : "s"} as a new design`}
            </button>
            {saveReason ? (
              <span className="studio-reason">{saveReason}</span>
            ) : (
              <span className="studio-reason">{design} stays as it is.</span>
            )}
          </span>
        </div>
        {saveError ? (
          <p role="alert" className="studio-error w-full text-sm">
            {saveError}
          </p>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="studio-muted rounded-[var(--dash-radius)] border border-dashed border-[var(--dash-border-strong)] px-6 py-8 text-center text-sm">
          Every slot in {design} already has a real picture. Untick the box
          above to see them all.
        </p>
      ) : null}

      <ul className="grid gap-3">
        {visible.map((slot) => {
          const image = staged[slot.id];
          const error = errors[slot.id];
          const name = pictureName(slot.id);
          const line = slot.history ? historyLine(slot.history) : null;
          return (
            <li
              key={slot.id}
              className="rounded-[var(--dash-radius)] border border-[var(--dash-border)] bg-[var(--dash-surface)] p-4"
            >
              <div className="flex flex-wrap gap-4">
                <div className="flex gap-3">
                  <figure className="grid w-32 gap-1">
                    <div className="flex h-24 w-32 items-center justify-center overflow-hidden rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)]">
                      {slot.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={slot.url}
                          alt={slot.alt}
                          loading="lazy"
                          decoding="async"
                          className="max-h-full max-w-full object-contain"
                        />
                      ) : (
                        <span className="studio-muted text-xs">No picture</span>
                      )}
                    </div>
                    <figcaption className="studio-muted text-center text-xs">
                      Now
                    </figcaption>
                  </figure>
                  {image ? (
                    <figure className="grid w-32 gap-1">
                      <div className="flex h-24 w-32 items-center justify-center overflow-hidden rounded-[var(--dash-radius-sm)] border-2 border-[var(--dash-accent)] bg-[var(--dash-surface-2)]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={image.url}
                          alt={image.alt}
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <figcaption className="text-center text-xs">
                        New, {image.width} by {image.height} px,{" "}
                        {kb(image.bytes)}
                      </figcaption>
                    </figure>
                  ) : null}
                </div>

                <div className="grid min-w-[16rem] flex-1 content-start gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{name}</h3>
                    <span className="studio-muted text-xs">
                      {ratio(slot.width, slot.height)}
                      {slot.catalogPreview ? ", at most 250 KB" : ""}
                    </span>
                    <span
                      className="studio-badge"
                      data-tone={slot.placeholder ? "warning" : "neutral"}
                    >
                      {slot.placeholder
                        ? "Placeholder"
                        : (SOURCE_LABEL[slot.source] ?? "Uploaded")}
                    </span>
                  </div>
                  {slot.usage.length ? (
                    <p className="studio-muted text-xs">
                      Shown on: {slot.usage.slice(0, 4).join("; ")}
                      {slot.usage.length > 4
                        ? ` and ${slot.usage.length - 4} more`
                        : ""}
                    </p>
                  ) : null}
                  {line ? (
                    <p
                      className={
                        line.tone === "bad" ? "studio-error text-xs" : "text-xs"
                      }
                    >
                      {line.text}
                    </p>
                  ) : null}
                  {slot.brief ? (
                    <details className="text-xs">
                      <summary className="studio-muted cursor-pointer">
                        What the image model is asked for
                      </summary>
                      <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
                        <dt className="studio-muted">Subject</dt>
                        <dd>{plainText(slot.brief.subject)}</dd>
                        {slot.brief.artDirection ? (
                          <>
                            <dt className="studio-muted">Direction</dt>
                            <dd>{plainText(slot.brief.artDirection)}</dd>
                          </>
                        ) : null}
                        <dt className="studio-muted">Shape</dt>
                        <dd>{slot.brief.aspectRatio}</dd>
                      </dl>
                    </details>
                  ) : null}

                  {image ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="grid gap-1 text-xs sm:col-span-2">
                        Description (alt text)
                        {slot.catalogScreenshot
                          ? ", at least 15 characters"
                          : ""}
                        <input
                          value={image.alt}
                          maxLength={200}
                          onChange={(event) =>
                            update(slot.id, { alt: event.target.value })
                          }
                          className="dash-input"
                        />
                      </label>
                      <label className="grid gap-1 text-xs">
                        Where it came from
                        <select
                          value={image.source}
                          onChange={(event) =>
                            update(slot.id, {
                              source: event.target.value as Source,
                            })
                          }
                          className="dash-input"
                        >
                          <option value="operator-owned">
                            Ours (photographed or made by us)
                          </option>
                          <option value="licensed">Licensed</option>
                        </select>
                      </label>
                      <div className="grid gap-1 text-xs">
                        <div className="flex items-center gap-1.5">
                          <label htmlFor={`studio-licence-${slot.id}`}>
                            Licence note
                          </label>
                          <InfoTip label="About the licence note">
                            Say where the picture came from, such as its licence
                            or who made it. Publish relies on it.
                          </InfoTip>
                        </div>
                        <input
                          id={`studio-licence-${slot.id}`}
                          value={image.licenseNote}
                          maxLength={300}
                          onChange={(event) =>
                            update(slot.id, {
                              licenseNote: event.target.value,
                            })
                          }
                          className="dash-input"
                        />
                      </div>
                    </div>
                  ) : null}

                  {error ? (
                    <p role="alert" className="studio-error text-xs">
                      {error}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      className={`studio-check-label dash-btn dash-btn-ghost dash-btn-sm ${
                        !canEdit || uploading
                          ? "pointer-events-none opacity-60"
                          : ""
                      }`}
                    >
                      {uploading === slot.id ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 studio-spin"
                        />
                      ) : (
                        <ImageUp aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {image ? "Replace the upload" : "Upload a picture"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/avif"
                        className="sr-only"
                        disabled={!canEdit || !!uploading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (file) void upload(slot, file);
                        }}
                      />
                    </label>
                    {slot.redrawable && !image ? (
                      <label className="studio-check-label inline-flex items-center gap-1.5 px-2 text-xs">
                        <input
                          id={`studio-redraw-${slot.id}`}
                          type="checkbox"
                          checked={redraw.has(slot.id)}
                          disabled={!canEdit}
                          onChange={(event) =>
                            toggleRedraw(slot.id, event.target.checked)
                          }
                        />
                        {slot.placeholder ? "Draw" : "Redraw"}
                      </label>
                    ) : null}
                    {image ? (
                      <button
                        type="button"
                        onClick={() => unstage(slot.id)}
                        className="dash-btn dash-btn-ghost dash-btn-sm"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                        Don&apos;t use it
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
