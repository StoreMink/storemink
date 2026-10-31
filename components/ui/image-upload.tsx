/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { uploadImage } from "@/lib/storage/uploads";
import {
  UploadCloud,
  Loader2,
  X,
  Check,
  Sparkles,
  Ruler,
  AlertTriangle,
  Eraser,
} from "lucide-react";
import { Button } from "./button";
import { ImageSourceMenu } from "./image-source-menu";
import {
  useImageBackgroundAvailable,
  useImageRefineAvailable,
  useImageRefineScope,
  useImageRefineView,
} from "./image-refine-context";
import {
  refineMatchKey,
  releaseImageRefines,
  settleImageRefine,
  startImageRefine,
} from "./image-refine-registry";
import { BackgroundEditor } from "./background-editor";
import {
  IMAGE_SPECS,
  imageFitWarning,
  type ImageSpecKey,
} from "@/lib/media/image-specs";

interface ImageUploadProps {
  onUploadSuccess: (url: string) => void;
  folder?: string;
  defaultImage?: string;
  className?: string;
  /**
   * The slot this image fills (`lib/media/image-specs.ts`). States the exact
   * size the storefront renders, warns when a photo will be cropped, and,
   * where the slot allows them, offers Refine with Mink AI and a background
   * change.
   */
  spec?: ImageSpecKey;
  /**
   * Called instead of `onUploadSuccess` when a refined photo, or one with a new
   * background, REPLACES the one just uploaded. Needed by list-style fields (a
   * product gallery) whose `onUploadSuccess` APPENDS, or accepting it would
   * add a second copy.
   */
  onReplace?: (previousUrl: string, nextUrl: string) => void;
  /**
   * When set, clicking the empty box asks where the image comes from: the
   * computer or the Media Library (the caller opens its picker). Without it
   * the box opens the file dialog straight away, as before.
   */
  onChooseFromLibrary?: () => void;
}

export function ImageUpload({
  onUploadSuccess,
  folder = "",
  defaultImage,
  className = "",
  spec,
  onReplace,
  onChooseFromLibrary,
}: ImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    defaultImage || null,
  );
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [editingBackground, setEditingBackground] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ★ The box follows its slot's photo (the caller's `defaultImage`): undo,
  //   a moved block or another section of the same type hands it another
  //   photo while it stays mounted. ★ Only a REAL change of photo resets the
  //   box: the echo of its own upload or "Use refined photo" (the caller
  //   writes back the URL the box already shows) must not wipe the measured
  //   size, because that image has already loaded and fires no second load.
  const [seenDefault, setSeenDefault] = useState(defaultImage);
  if (defaultImage !== seenDefault) {
    setSeenDefault(defaultImage);
    if (!pendingPreview && (defaultImage || null) !== previewUrl) {
      setPreviewUrl(defaultImage || null);
      setNatural(null);
      setEditingBackground(false);
    }
  }
  // ★★ A REFINE BELONGS TO ITS PAGE AND SLOT, NOT TO THIS BOX
  //   (image-refine-registry.ts). Unmounting the box (a collapsed group,
  //   another builder section, a dialog's tab) only detaches it; the page
  //   sends the refine's stop when it goes away, and the server decides
  //   whether the stop or the charge came first. A box shows the refine of
  //   its scope, slot size and the photo it shows now, wherever it mounts.
  const pathname = usePathname() ?? "";
  const scope = useImageRefineScope() ?? `route:${pathname}`;
  const matchKey =
    previewUrl && spec ? refineMatchKey(scope, spec, previewUrl) : null;
  const view = useImageRefineView(matchKey);
  const refining = view?.status === "running";
  const refined = view?.status === "done" ? { url: view.resultUrl } : null;
  const refineError = view?.status === "failed" ? view.message : null;
  // ★ The slot's size changed under its photo (a section's ratio, the hero's
  //   layout): a photo made for the old size would be the wrong size here,
  //   so that refine is stopped (nothing charged unless its charge came
  //   first) or, finished, dropped (it stays in the Media Library).
  const lastSlot = useRef<{
    scope: string;
    spec?: ImageSpecKey;
    previewUrl: string | null;
  } | null>(null);
  useEffect(() => {
    const previous = lastSlot.current;
    lastSlot.current = { scope, spec, previewUrl };
    if (
      previous?.spec &&
      previewUrl &&
      previous.scope === scope &&
      previous.previewUrl === previewUrl &&
      previous.spec !== spec
    ) {
      releaseImageRefines(
        (refine) =>
          refine.scope === previous.scope &&
          refine.spec === previous.spec &&
          refine.sourceUrl === previewUrl,
      );
    }
  }, [scope, spec, previewUrl]);
  const refineAvailable = useImageRefineAvailable();
  const backgroundAvailable = useImageBackgroundAvailable();
  const slot = spec ? IMAGE_SPECS[spec] : null;
  const canRefine = Boolean(slot?.refine && refineAvailable);
  const canBackground = Boolean(slot?.background && backgroundAvailable);

  const validateAndStage = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Please select a valid image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Image must be smaller than 5MB.");
      return;
    }
    setError(null);
    setNatural(null);
    setPendingFile(file);
    setPendingPreview(URL.createObjectURL(file));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) validateAndStage(file);
  };

  const handleConfirm = async () => {
    if (!pendingFile || !pendingPreview) return;
    setIsUploading(true);
    try {
      const uploadedUrl = await uploadImage(pendingFile, { folder });
      setPreviewUrl(uploadedUrl);
      onUploadSuccess(uploadedUrl);
      setPendingFile(null);
      setPendingPreview(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to upload image. Please try again.";
      setError(message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleCancel = () => {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(null);
    setPendingPreview(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRemoveUploaded = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewUrl(null);
    setEditingBackground(false);
    setNatural(null);
    onUploadSuccess("");
  };

  const triggerFileInput = () => {
    if (!pendingPreview) fileInputRef.current?.click();
  };

  const handleRefine = () => {
    if (!previewUrl || !spec || refining) return;
    setError(null);
    startImageRefine({ scope, pathname, spec, sourceUrl: previewUrl });
  };

  const replaceWith = (nextUrl: string) => {
    if (!previewUrl) return;
    if (onReplace) onReplace(previewUrl, nextUrl);
    else onUploadSuccess(nextUrl);
    setPreviewUrl(nextUrl);
    setNatural(null);
  };

  const acceptRefined = () => {
    if (!refined || !matchKey) return;
    const settled = matchKey;
    replaceWith(refined.url);
    settleImageRefine(settled);
  };

  const sizeLine = slot && (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
      <Ruler className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Best size:{" "}
        <strong className="font-semibold text-foreground">
          {slot.width} × {slot.height} px
        </strong>{" "}
        ({slot.aspect}). {slot.hint}
      </span>
    </p>
  );

  const fitWarning =
    slot && natural ? imageFitWarning(natural.w, natural.h, slot) : null;

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight)
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  };

  // — Preview modal (pending confirmation) —
  if (pendingPreview) {
    return (
      <div className={`w-full ${className}`}>
        <div className="relative w-full h-48 rounded-lg border border-border overflow-hidden bg-muted/30">
          <img
            src={pendingPreview}
            alt="Preview"
            onLoad={onImgLoad}
            className="absolute inset-0 w-full h-full object-contain"
          />
          <div className="absolute bottom-0 inset-x-0 bg-background/90 border-t border-border px-3 py-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground truncate">
              {pendingFile?.name}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCancel}
                disabled={isUploading}
                className="gap-1.5"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleConfirm}
                disabled={isUploading}
                className="gap-1.5"
              >
                {isUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {isUploading ? "Uploading…" : "OK, upload"}
              </Button>
            </div>
          </div>
        </div>
        {sizeLine}
        {fitWarning && <FitWarning text={fitWarning} />}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  // — Background: choose one, compare, then use it or keep the original —
  if (previewUrl && spec && editingBackground) {
    return (
      <div className={`w-full ${className}`}>
        <BackgroundEditor
          sourceUrl={previewUrl}
          spec={spec}
          onUse={(url) => {
            replaceWith(url);
            setEditingBackground(false);
          }}
          onClose={() => setEditingBackground(false)}
        />
      </div>
    );
  }

  // — Refined result: compare, then choose —
  if (previewUrl && refined) {
    return (
      <div className={`w-full ${className}`}>
        <div className="grid grid-cols-2 gap-2">
          <figure className="min-w-0">
            <div className="relative h-48 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
              <img
                src={previewUrl}
                alt="Original"
                className="absolute inset-0 h-full w-full object-contain"
              />
            </div>
            <figcaption className="mt-1 text-xs text-muted-foreground">
              Original
            </figcaption>
          </figure>
          <figure className="min-w-0">
            <div className="relative h-48 overflow-hidden rounded-lg border-2 border-primary/60 bg-muted/30">
              <RefinedImage key={refined.url} url={refined.url} />
            </div>
            <figcaption className="mt-1 text-xs text-muted-foreground">
              Refined · {slot?.width} × {slot?.height} px
            </figcaption>
          </figure>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Check it matches the real item before using it. A copy is saved in
          your Media Library.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={acceptRefined}
            className="gap-1.5"
          >
            <Check className="h-3.5 w-3.5" />
            Use refined photo
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (matchKey) settleImageRefine(matchKey);
            }}
          >
            Keep original
          </Button>
        </div>
      </div>
    );
  }

  // — Uploaded state —
  if (previewUrl) {
    return (
      <div className={`w-full ${className}`}>
        <div className="relative w-full h-48 rounded-lg border border-border/50 overflow-hidden bg-muted/30">
          <img
            src={previewUrl}
            alt="Uploaded"
            onLoad={onImgLoad}
            className="absolute inset-0 w-full h-full object-contain"
          />
          <button
            onClick={handleRemoveUploaded}
            type="button"
            aria-label="Remove image"
            disabled={refining}
            className="absolute top-2 right-2 p-1.5 bg-background/80 backdrop-blur-md rounded-md hover:bg-destructive hover:text-destructive-foreground transition-colors shadow-sm"
          >
            <X className="h-4 w-4" />
          </button>
          {refining && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/75 text-sm text-foreground backdrop-blur-sm">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              <span role="status">Refining… this takes about 20 seconds</span>
            </div>
          )}
        </div>
        {sizeLine}
        {fitWarning && <FitWarning text={fitWarning} />}
        {(canRefine || canBackground) && (
          <div className="mt-2">
            <div className="flex flex-wrap gap-2">
              {canRefine && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleRefine}
                  disabled={refining}
                  className="gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Refine with Mink AI
                </Button>
              )}
              {canBackground && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    setEditingBackground(true);
                  }}
                  disabled={refining}
                  className="gap-1.5"
                >
                  <Eraser className="h-3.5 w-3.5" />
                  Change background
                </Button>
              )}
            </div>
            {canRefine && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Retouches the photo and resizes it to {slot?.width} ×{" "}
                {slot?.height} px. You compare before using it.
              </p>
            )}
            {canBackground && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Puts your real product on white, a colour or a transparent
                background.
              </p>
            )}
          </div>
        )}
        {(error ?? refineError) && (
          <p className="mt-2 text-sm text-destructive">
            {error ?? refineError}
          </p>
        )}
      </div>
    );
  }

  // — Empty / idle state —
  const dropzoneClass = `flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-lg cursor-pointer transition-colors
          ${error ? "border-destructive/50 bg-destructive/5" : "border-border hover:bg-muted/50"}`;
  return (
    <div className={`w-full ${className}`}>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/png, image/jpeg, image/webp, image/svg+xml"
        className="hidden"
      />
      {onChooseFromLibrary ? (
        <ImageSourceMenu
          onUpload={triggerFileInput}
          onChooseFromLibrary={onChooseFromLibrary}
          className={`${dropzoneClass} w-full`}
        >
          <div className="flex flex-col items-center justify-center pt-5 pb-6 text-muted-foreground">
            <UploadCloud className="w-8 h-8 mb-3" />
            <p className="mb-1 text-sm font-medium">
              <span className="text-primary">Add an image</span>
            </p>
            <p className="text-xs">From your computer or your Media Library</p>
            <p className="mt-1 text-xs">PNG, JPG, WEBP, SVG (MAX. 5MB)</p>
          </div>
        </ImageSourceMenu>
      ) : (
        <div onClick={triggerFileInput} className={dropzoneClass}>
          <div className="flex flex-col items-center justify-center pt-5 pb-6 text-muted-foreground">
            <UploadCloud className="w-8 h-8 mb-3" />
            <p className="mb-1 text-sm font-medium">
              <span className="text-primary">Click to upload</span> or drag and
              drop
            </p>
            <p className="text-xs">PNG, JPG, WEBP, SVG (MAX. 5MB)</p>
          </div>
        </div>
      )}
      {sizeLine}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The refined photo in the compare view. ★ It retries a failed load, up to
 * five times two seconds apart: a refine whose answer was lost can come back
 * as `too_late` in the moment between its charge and its publish. The retry
 * asks for `?retry=n`; "Use refined photo" still writes the clean URL.
 */
function RefinedImage({ url }: { url: string }) {
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const src = attempt
    ? `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`
    : url;
  return (
    <img
      src={src}
      alt="Refined with Mink AI"
      onError={() => {
        if (attempt >= 5 || timer.current) return;
        timer.current = setTimeout(() => {
          timer.current = null;
          setAttempt((n) => n + 1);
        }, 2_000);
      }}
      className="absolute inset-0 h-full w-full object-contain"
    />
  );
}

function FitWarning({ text }: { text: string }) {
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );
}
