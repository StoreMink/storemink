"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ImagePlus, Loader2, X } from "lucide-react";
import {
  createThemeStudioProjectAction,
  queueThemeStudioGenerationAction,
} from "@/app/actions/theme-studio-actions";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import {
  INDUSTRY_LABELS,
  type ThemeCatalogSize,
  type ThemeFeature,
  type ThemeIndustry,
} from "@/lib/themes/meta";
import type { ThemeStudioModelKey } from "@/lib/theme-studio/models";
import { plainText } from "../studio-ui";
import {
  checkScreenshots,
  fileSizeWords,
  guessIndustry,
  newIdempotencyKey,
  SCREENSHOT_ACCEPT,
  startRefusedKey,
  themeIdFromName,
  themeIdProblem,
  type ScreenshotLimits,
} from "./new-theme-helpers";

// ---------------------------------------------------------------------------
// New theme, on one screen (wave TS-2, builder 2D; plan section 4, "New
// theme"): name, brief, screenshots and industry, the rest under "More
// options", and one button.
//
// ★ "CREATE AND START" CHAINS THREE EXISTING STEPS: create the theme
// (createThemeStudioProjectAction), add each screenshot (the raw-body
// references route, one file per request, so each shows its own progress),
// then queue the build (queueThemeStudioGenerationAction with
// expectedRevision 0: a new theme's revision is 0 and adding screenshots does
// not move it). Every value is re-validated by the server.
//
// ★ ONCE THE THEME EXISTS, THE THEME PAGE TAKES OVER. If a screenshot or the
// start is refused (building switched off, the model switched off, two builds
// already running, the daily spend cap, a stale page), the server's sentence
// is left in sessionStorage under `studio:start-refused:<id>` and the
// operator lands on the theme page, which shows it under "Start building"
// with the brief and every added screenshot kept. Nothing is created twice:
// the form never creates again after the theme exists.
//
// ★ NO BROWSER VALIDATION BUBBLES (`noValidate`): they are tooltips, which
// never open on touch, so every problem is a sentence under its field.
// ---------------------------------------------------------------------------

const SIZE_LABELS: Record<ThemeCatalogSize, string> = {
  "one-product": "One product",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

const MAX_INDUSTRIES = 5;

function humanize(value: string): string {
  const text = value.replace(/-/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function industryLabel(value: ThemeIndustry): string {
  return INDUSTRY_LABELS[value] ?? humanize(value);
}

/** What New theme starts with when it opens from another theme's brief
 * (`?from=`, read on the server by new/page.tsx). */
export interface NewThemeInitial {
  name: string;
  brief: string;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  requiredFeatures: ThemeFeature[];
  baseThemeId: string | null;
  modelKey: ThemeStudioModelKey | null;
}

type UploadState = "checked" | "uploading" | "added" | "failed";

interface Screenshot {
  key: string;
  file: File;
  state: UploadState;
  /** 0 to 100 while it uploads. */
  progress: number;
  error: string | null;
}

type Phase = "idle" | "creating" | "uploading" | "starting" | "done";

type FieldErrors = Partial<
  Record<"name" | "themeId" | "brief" | "industries" | "sizes", string>
>;

/**
 * Add one screenshot to a theme through the references route (raw bytes,
 * one file per request), reporting upload progress. A network failure or a
 * refusal answers `{ ok: false }` with a plain sentence; it never throws.
 */
export function uploadScreenshot(
  projectId: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `/api/platform/theme-studio/projects/${encodeURIComponent(projectId)}/references`,
    );
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      let body: { id?: unknown; error?: unknown } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        body = {};
      }
      if (
        request.status >= 200 &&
        request.status < 300 &&
        typeof body.id === "string"
      ) {
        resolve({ ok: true, id: body.id });
        return;
      }
      resolve({
        ok: false,
        error:
          typeof body.error === "string"
            ? plainText(body.error)
            : "The server did not accept it.",
      });
    };
    request.onerror = () =>
      resolve({
        ok: false,
        error: "The connection dropped while it uploaded.",
      });
    request.onabort = () =>
      resolve({ ok: false, error: "The upload was stopped." });
    request.send(file);
  });
}

/** Leave the server's reason for the theme page (contract section 8.1). */
function rememberRefusedStart(projectId: string, reason: string) {
  try {
    window.sessionStorage.setItem(startRefusedKey(projectId), reason);
  } catch {
    // Private mode or a full storage: the theme page still says "Not started".
  }
}

function Chips<T extends string>({
  options,
  selected,
  onChange,
  label,
  max,
  disabled,
}: {
  options: readonly T[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  label: (value: T) => string;
  max?: number;
  disabled?: boolean;
}) {
  const full = max !== undefined && selected.length >= max;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((value) => {
        const on = selected.includes(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            disabled={disabled || (full && !on)}
            onClick={() =>
              onChange(
                on ? selected.filter((v) => v !== value) : [...selected, value],
              )
            }
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 max-md:min-h-11 pointer-coarse:min-h-11 ${
              on
                ? "border-[var(--dash-accent)] bg-[var(--dash-accent-soft)] text-[var(--dash-text)]"
                : "border-[var(--dash-border-strong)] bg-[var(--dash-surface)] text-[var(--dash-text-2)] hover:text-[var(--dash-text)]"
            }`}
          >
            {on ? <Check aria-hidden className="h-3.5 w-3.5" /> : null}
            {label(value)}
          </button>
        );
      })}
    </div>
  );
}

const LABEL = "block text-sm font-semibold text-[var(--dash-text)]";
const FIELD = "dash-input mt-1.5 w-full";

export function NewProjectForm({
  models,
  baseThemes,
  industries,
  catalogSizes,
  features,
  briefMax,
  limits,
  buildingOff,
  buildingOffReason,
  initial,
}: {
  /** The models this deployment can build with (keys and labels only). */
  models: { key: ThemeStudioModelKey; label: string; purpose: string }[];
  /** Only the bundled themes the server accepts as a starting point. */
  baseThemes: { id: string; name: string }[];
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  features: ThemeFeature[];
  briefMax: number;
  limits: ScreenshotLimits;
  /** Building is switched off here: the button only creates. */
  buildingOff: boolean;
  /** Why, in one sentence, when `buildingOff`. */
  buildingOffReason?: string | null;
  initial?: NewThemeInitial | null;
}) {
  const router = useRouter();
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;
  const nameInput = useRef<HTMLInputElement>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const briefInput = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstIndustry = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const nextKey = useRef(0);

  const [name, setName] = useState(initial?.name ?? "");
  const [themeId, setThemeId] = useState(themeIdFromName(initial?.name ?? ""));
  const [idTouched, setIdTouched] = useState(false);
  const [editingId, setEditingId] = useState(false);
  const [brief, setBrief] = useState(initial?.brief ?? "");
  const [industriesTouched, setIndustriesTouched] = useState(
    (initial?.industries.length ?? 0) > 0,
  );
  const [chosenIndustries, setIndustries] = useState<ThemeIndustry[]>(
    initial?.industries ?? [],
  );
  const [sizes, setSizes] = useState<ThemeCatalogSize[]>(
    initial?.catalogSizes.length ? initial.catalogSizes : ["small"],
  );
  const [chosenFeatures, setFeatures] = useState<ThemeFeature[]>(
    initial?.requiredFeatures ?? [],
  );
  const [baseThemeId, setBaseThemeId] = useState(initial?.baseThemeId ?? "");
  const [modelKey, setModelKey] = useState<ThemeStudioModelKey>(
    initial?.modelKey ?? models[0]?.key ?? "gemini-3.8-flash",
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const guessed = industriesTouched ? null : guessIndustry(brief, industries);
  const industriesNow = industriesTouched
    ? chosenIndustries
    : guessed
      ? [guessed]
      : [];
  const pending = phase !== "idle";
  const dirty =
    phase !== "done" &&
    (name !== (initial?.name ?? "") ||
      brief !== (initial?.brief ?? "") ||
      screenshots.length > 0);
  useUnsavedChangesWarning(dirty);

  function addFiles(files: File[]) {
    if (pending || files.length === 0) return;
    const { accepted, problems: refused } = checkScreenshots(
      screenshots.map((item) => item.file),
      files,
      limits,
    );
    setProblems(refused);
    if (accepted.length === 0) return;
    setScreenshots((current) => [
      ...current,
      ...accepted.map((file) => ({
        key: `shot-${(nextKey.current += 1)}`,
        file,
        state: "checked" as const,
        progress: 0,
        error: null,
      })),
    ]);
  }

  function updateShot(key: string, patch: Partial<Screenshot>) {
    setScreenshots((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (!name.trim()) found.name = "Give the theme a name.";
    const idWrong = themeIdProblem(themeId);
    if (idWrong) found.themeId = idWrong;
    if (!brief.trim()) found.brief = "Describe the store this theme is for.";
    if (industriesNow.length === 0)
      found.industries = "Choose at least one industry.";
    if (sizes.length === 0) found.sizes = "Choose at least one catalogue size.";
    return found;
  }

  async function createAndStart(event: React.FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      if (found.themeId) setEditingId(true);
      if (found.sizes) setMoreOpen(true);
      // Focus the first field that needs a change, after it has rendered.
      requestAnimationFrame(() => {
        if (found.name) nameInput.current?.focus();
        else if (found.themeId) idInput.current?.focus();
        else if (found.brief) briefInput.current?.focus();
        else if (found.industries)
          firstIndustry.current?.querySelector("button")?.focus();
      });
      return;
    }

    busy.current = true;
    setPhase("creating");
    const created = await createThemeStudioProjectAction({
      name: name.trim(),
      themeId,
      brief: brief.trim(),
      industries: industriesNow,
      catalogSizes: sizes,
      requiredFeatures: chosenFeatures,
      baseThemeId: baseThemeId || null,
      modelKey,
    }).catch(() => null);
    if (!created?.ok || !created.id) {
      const reason = created
        ? plainText(created.error ?? "The theme couldn't be created.")
        : "Theme Studio couldn't be reached, so nothing was created. Try again.";
      setError(reason);
      // Every refusal that names the ID is answered by changing the ID.
      if (/\bid\b/i.test(reason)) setEditingId(true);
      busy.current = false;
      setPhase("idle");
      return;
    }
    const projectId = created.id;

    // The theme exists from here on: never create it again, whatever fails.
    setPhase("uploading");
    const added: string[] = [];
    const failed: string[] = [];
    for (const item of screenshots) {
      updateShot(item.key, { state: "uploading", progress: 0, error: null });
      const result = await uploadScreenshot(projectId, item.file, (percent) =>
        updateShot(item.key, { progress: percent }),
      );
      if (result.ok) {
        added.push(result.id);
        updateShot(item.key, { state: "added", progress: 100 });
      } else {
        failed.push(`${item.file.name}: ${result.error}`);
        updateShot(item.key, { state: "failed", error: result.error });
      }
    }

    let refused: string | null = null;
    if (failed.length > 0) {
      refused = `${failed.length === 1 ? "A screenshot" : `${failed.length} screenshots`} couldn't be added, so nothing was started. ${failed.join(" ")} Add ${failed.length === 1 ? "it" : "them"} again here, or start without ${failed.length === 1 ? "it" : "them"}.`;
    } else if (!buildingOff) {
      setPhase("starting");
      const queued = await queueThemeStudioGenerationAction({
        projectId,
        expectedRevision: 0,
        body: brief.trim(),
        referenceAssetIds: added,
        idempotencyKey: newIdempotencyKey(),
      }).catch(() => null);
      if (!queued) {
        refused =
          "The start couldn't be confirmed. If this theme is not building, press Start building.";
      } else if (!queued.ok) {
        refused = plainText(queued.error ?? "The build couldn't be started.");
      }
    }
    if (refused) rememberRefusedStart(projectId, refused);
    setPhase("done");
    router.push(`/dashboard/themes/studio/${projectId}`);
  }

  const addedCount = screenshots.filter(
    (item) => item.state === "added" || item.state === "failed",
  ).length;
  const buttonWords =
    phase === "creating"
      ? "Creating the theme"
      : phase === "uploading"
        ? `Adding screenshots (${Math.min(addedCount + 1, screenshots.length)} of ${screenshots.length})`
        : phase === "starting"
          ? "Starting the build"
          : phase === "done"
            ? "Opening the theme"
            : buildingOff
              ? "Create (building is switched off)"
              : "Create and start";
  const model = models.find((m) => m.key === modelKey);
  const moreSummary = [
    sizes.map((s) => SIZE_LABELS[s] ?? humanize(s)).join(", ") || "no size",
    chosenFeatures.length
      ? `${chosenFeatures.length} must-have ${chosenFeatures.length === 1 ? "feature" : "features"}`
      : null,
    baseThemes.find((t) => t.id === baseThemeId)?.name ?? null,
    model?.label ?? null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <form
      noValidate
      onSubmit={createAndStart}
      onPaste={(event) => {
        const images = Array.from(event.clipboardData.files).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (images.length) {
          event.preventDefault();
          addFiles(images);
        }
      }}
      className="dash-card"
    >
      <div className="dash-card-body space-y-7">
        <div>
          <label htmlFor={fieldId("name")} className={LABEL}>
            Name
          </label>
          <input
            ref={nameInput}
            id={fieldId("name")}
            className={FIELD}
            value={name}
            maxLength={100}
            autoComplete="off"
            disabled={pending}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={`${fieldId("id-line")}${errors.name ? ` ${fieldId("name-error")}` : ""}`}
            onChange={(e) => {
              setName(e.target.value);
              if (!idTouched) setThemeId(themeIdFromName(e.target.value));
            }}
          />
          {errors.name ? (
            <p
              id={fieldId("name-error")}
              className="studio-error mt-1.5 text-sm"
            >
              {errors.name}
            </p>
          ) : null}
          <p id={fieldId("id-line")} className="studio-muted mt-1.5 text-sm">
            ID:{" "}
            <span className="font-mono text-[var(--dash-text)]">
              {themeId || "none yet"}
            </span>{" "}
            <button
              type="button"
              className="inline-flex items-center font-medium text-[var(--dash-text)] underline underline-offset-2 max-md:min-h-11 pointer-coarse:min-h-11"
              aria-expanded={editingId}
              aria-controls={fieldId("theme-id-box")}
              disabled={pending}
              onClick={() => setEditingId((open) => !open)}
            >
              (change)
            </button>
          </p>
          {editingId ? (
            <div id={fieldId("theme-id-box")} className="mt-3">
              <label htmlFor={fieldId("theme-id")} className={LABEL}>
                Theme ID
              </label>
              <input
                ref={idInput}
                id={fieldId("theme-id")}
                className={`${FIELD} font-mono`}
                value={themeId}
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                aria-invalid={errors.themeId ? true : undefined}
                aria-describedby={`${fieldId("theme-id-help")}${errors.themeId ? ` ${fieldId("theme-id-error")}` : ""}`}
                onChange={(e) => {
                  setIdTouched(true);
                  setThemeId(e.target.value.toLowerCase().trim());
                }}
              />
              <p
                id={fieldId("theme-id-help")}
                className="studio-muted mt-1.5 text-sm"
              >
                Lowercase letters and numbers joined by single hyphens. It also
                names the theme&apos;s demo store. If this ID belonged to a
                deleted theme, a new ending is added for you and the name stays.
              </p>
              {errors.themeId ? (
                <p
                  id={fieldId("theme-id-error")}
                  className="studio-error mt-1.5 text-sm"
                >
                  {errors.themeId}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div>
          <label htmlFor={fieldId("brief")} className={LABEL}>
            Brief
          </label>
          <textarea
            ref={briefInput}
            id={fieldId("brief")}
            className={`${FIELD} min-h-40`}
            value={brief}
            maxLength={briefMax}
            disabled={pending}
            aria-invalid={errors.brief ? true : undefined}
            aria-describedby={`${fieldId("brief-count")}${errors.brief ? ` ${fieldId("brief-error")}` : ""}`}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Who the store sells to, what should feel distinctive, which pages matter most, and what to avoid."
          />
          <p
            id={fieldId("brief-count")}
            className="studio-muted mt-1.5 text-sm"
          >
            {brief.length.toLocaleString("en-IN")} of{" "}
            {briefMax.toLocaleString("en-IN")} characters.
          </p>
          {errors.brief ? (
            <p
              id={fieldId("brief-error")}
              className="studio-error mt-1.5 text-sm"
            >
              {errors.brief}
            </p>
          ) : null}
        </div>

        <div>
          <div
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                if (!pending) setDragging(true);
              }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              setDragging(false);
              if (event.dataTransfer.files.length) {
                event.preventDefault();
                addFiles(Array.from(event.dataTransfer.files));
              }
            }}
            data-dragging={dragging || undefined}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-[var(--dash-radius)] border-2 border-dashed px-4 py-4 ${
              dragging
                ? "border-[var(--dash-accent)] bg-[var(--dash-accent-soft)]"
                : "border-[var(--dash-border-strong)] bg-[var(--dash-surface-2)]"
            }`}
          >
            <p className="text-sm font-medium text-[var(--dash-text)]">
              Drop or paste screenshots of stores you like (up to {limits.files}
              )
            </p>
            <button
              type="button"
              className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
              disabled={pending || screenshots.length >= limits.files}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus aria-hidden className="h-4 w-4" />
              Choose screenshots
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={SCREENSHOT_ACCEPT}
              className="hidden"
              aria-label="Choose screenshots"
              tabIndex={-1}
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
          {screenshots.length >= limits.files ? (
            <p className="studio-reason mt-1.5 text-sm">
              That is the most a theme starts with. Remove one to add another.
            </p>
          ) : null}
          <p className="studio-muted mt-1.5 text-sm">
            JPEG, PNG, WebP or AVIF, up to {fileSizeWords(limits.fileBytes)}{" "}
            each and {fileSizeWords(limits.totalBytes)} in all. They are
            inspiration only: Theme Studio takes the layout and the feel, and
            never copies logos, words, product photos or artwork.
          </p>
          {problems.length > 0 ? (
            <ul role="alert" className="studio-error mt-2 space-y-1 text-sm">
              {problems.map((problem, index) => (
                <li key={`${index}-${problem}`}>{problem}</li>
              ))}
            </ul>
          ) : null}
          {screenshots.length > 0 ? (
            <ul
              aria-label="Screenshots"
              className="mt-3 divide-y divide-[var(--dash-border)] rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)]"
            >
              {screenshots.map((item) => (
                <li
                  key={item.key}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
                >
                  <span className="min-w-0 flex-1 basis-40 break-all text-sm font-medium text-[var(--dash-text)]">
                    {item.file.name}
                  </span>
                  <span className="studio-muted text-sm">
                    {fileSizeWords(item.file.size)}
                  </span>
                  <span
                    className={`text-sm ${item.state === "failed" ? "studio-error" : "studio-muted"}`}
                  >
                    {item.state === "checked"
                      ? "Checked"
                      : item.state === "uploading"
                        ? `Uploading, ${item.progress}%`
                        : item.state === "added"
                          ? "Added"
                          : `Couldn't add: ${item.error}`}
                  </span>
                  {item.state === "uploading" || item.state === "added" ? (
                    <div
                      role="progressbar"
                      aria-label={`Uploading ${item.file.name}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={item.progress}
                      className="dash-progress-track w-full"
                    >
                      <div
                        className="dash-progress-fill bg-[var(--dash-accent)]"
                        style={{ width: `${item.progress}%` }}
                      />
                    </div>
                  ) : null}
                  {item.state === "checked" ? (
                    <button
                      type="button"
                      className="dash-btn dash-btn-ghost dash-btn-sm pointer-coarse:min-h-11"
                      disabled={pending}
                      aria-label={`Remove ${item.file.name}`}
                      onClick={() =>
                        setScreenshots((current) =>
                          current.filter((shot) => shot.key !== item.key),
                        )
                      }
                    >
                      <X aria-hidden className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <fieldset
          aria-describedby={
            errors.industries ? fieldId("industries-error") : undefined
          }
        >
          <legend className={LABEL}>Industries (1 to {MAX_INDUSTRIES})</legend>
          <div ref={firstIndustry} className="mt-2">
            <Chips
              options={industries}
              selected={industriesNow}
              max={MAX_INDUSTRIES}
              disabled={pending}
              onChange={(next) => {
                setIndustriesTouched(true);
                setIndustries(next.slice(0, MAX_INDUSTRIES));
              }}
              label={industryLabel}
            />
          </div>
          {guessed ? (
            <p className="studio-muted mt-2 text-sm">
              Picked from your brief: {industryLabel(guessed)}. Change it if it
              is wrong.
            </p>
          ) : null}
          {industriesNow.length >= MAX_INDUSTRIES ? (
            <p className="studio-reason mt-2 text-sm">
              That is the most a theme takes. Remove one to choose another.
            </p>
          ) : null}
          {errors.industries ? (
            <p
              id={fieldId("industries-error")}
              className="studio-error mt-2 text-sm"
            >
              {errors.industries}
            </p>
          ) : null}
        </fieldset>

        <details
          open={moreOpen}
          onToggle={(event) => setMoreOpen(event.currentTarget.open)}
          className="group rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)]"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 max-md:min-h-11 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronDown
              aria-hidden
              className="h-4 w-4 shrink-0 text-[var(--dash-text-2)] transition group-open:rotate-180"
            />
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold text-[var(--dash-text)]">
                More options
              </span>
              <span className="studio-muted text-sm">{moreSummary}</span>
            </span>
          </summary>
          <div className="space-y-6 border-t border-[var(--dash-border)] px-4 py-4">
            <fieldset>
              <legend className={LABEL}>Catalogue size</legend>
              <div className="mt-2">
                <Chips
                  options={catalogSizes}
                  selected={sizes}
                  disabled={pending}
                  onChange={setSizes}
                  label={(v) => SIZE_LABELS[v] ?? humanize(v)}
                />
              </div>
              {errors.sizes ? (
                <p className="studio-error mt-2 text-sm">{errors.sizes}</p>
              ) : null}
            </fieldset>

            <fieldset>
              <legend className={LABEL}>Must-have features</legend>
              <div className="mt-2">
                <Chips
                  options={features}
                  selected={chosenFeatures}
                  disabled={pending}
                  onChange={setFeatures}
                  label={humanize}
                />
              </div>
            </fieldset>

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor={fieldId("base")} className={LABEL}>
                  Start from a theme
                </label>
                <select
                  id={fieldId("base")}
                  className={FIELD}
                  value={baseThemeId}
                  disabled={pending}
                  aria-describedby={fieldId("base-help")}
                  onChange={(e) => setBaseThemeId(e.target.value)}
                >
                  <option value="">None</option>
                  {baseThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <p
                  id={fieldId("base-help")}
                  className="studio-muted mt-1.5 text-sm"
                >
                  StoreMink&apos;s own themes only: a theme made in Theme Studio
                  can&apos;t be a starting point yet.
                </p>
              </div>
              <div>
                <label htmlFor={fieldId("model")} className={LABEL}>
                  Model
                </label>
                <select
                  id={fieldId("model")}
                  className={FIELD}
                  value={modelKey}
                  disabled={pending}
                  aria-describedby={fieldId("model-help")}
                  onChange={(e) =>
                    setModelKey(e.target.value as ThemeStudioModelKey)
                  }
                >
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p
                  id={fieldId("model-help")}
                  className="studio-muted mt-1.5 text-sm"
                >
                  {model?.purpose}
                </p>
              </div>
            </div>
          </div>
        </details>

        {error ? (
          <p role="alert" className="studio-error text-sm">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <button
            type="submit"
            className="dash-btn dash-btn-primary pointer-coarse:min-h-11"
            disabled={pending}
          >
            {pending ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : null}
            {buttonWords}
          </button>
          {buildingOff ? (
            <p className="studio-reason text-sm sm:text-right">
              {buildingOffReason ??
                "Building is switched off on this deployment."}{" "}
              The theme is created with its brief and screenshots, and you can
              start it from its page once building is back on.
            </p>
          ) : null}
          <p aria-live="polite" className="sr-only">
            {pending ? buttonWords : ""}
          </p>
        </div>
      </div>
    </form>
  );
}
