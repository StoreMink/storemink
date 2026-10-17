/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, useRef } from "react";
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
  useImageScenesAvailable,
} from "./image-refine-context";
import { BackgroundEditor } from "./background-editor";
import {
  IMAGE_CUTOUT_CREDITS,
  IMAGE_REFINE_CREDITS,
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

type RefineResult = { url: string; chargedCredits: number };

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
  const [refining, setRefining] = useState(false);
  const [refined, setRefined] = useState<RefineResult | null>(null);
  const [editingBackground, setEditingBackground] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refineAvailable = useImageRefineAvailable();
  const backgroundAvailable = useImageBackgroundAvailable();
  const scenesAvailable = useImageScenesAvailable();
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
      setRefined(null);
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
    setRefined(null);
    setEditingBackground(false);
    setNatural(null);
    onUploadSuccess("");
  };

  const triggerFileInput = () => {
    if (!pendingPreview) fileInputRef.current?.click();
  };

  const handleRefine = async () => {
    if (!previewUrl || !spec || refining) return;
    setRefining(true);
    setError(null);
    try {
      const res = await fetch("/api/mink/image-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: previewUrl, spec }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        chargedCredits?: number;
        error?: string;
      };
      if (!res.ok || !body.url) {
        setError(body.error ?? "Refining failed. Nothing was charged.");
        return;
      }
      setRefined({ url: body.url, chargedCredits: body.chargedCredits ?? 0 });
    } catch {
      setError("Refining failed. Check your connection and try again.");
    } finally {
      setRefining(false);
    }
  };

  const replaceWith = (nextUrl: string) => {
    if (!previewUrl) return;
    if (onReplace) onReplace(previewUrl, nextUrl);
    else onUploadSuccess(nextUrl);
    setPreviewUrl(nextUrl);
    setNatural(null);
  };

  const acceptRefined = () => {
    if (!refined) return;
    replaceWith(refined.url);
    setRefined(null);
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
          scenesAvailable={scenesAvailable}
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
              <img
                src={refined.url}
                alt="Refined with Mink AI"
                className="absolute inset-0 h-full w-full object-contain"
              />
            </div>
            <figcaption className="mt-1 text-xs text-muted-foreground">
              Refined · {slot?.width} × {slot?.height} px
            </figcaption>
          </figure>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Check that the product looks exactly like the real item before you use
          it.
          {refined.chargedCredits > 0 &&
            ` ${refined.chargedCredits} Mink credits were used.`}{" "}
          The refined copy is also saved in your Media Library.
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
            onClick={() => setRefined(null)}
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
                  <span className="text-muted-foreground">
                    · {IMAGE_REFINE_CREDITS} credits
                  </span>
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
                  <span className="text-muted-foreground">
                    · {IMAGE_CUTOUT_CREDITS} credit
                  </span>
                </Button>
              )}
            </div>
            {canRefine && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Retouches lighting and background and resizes to exactly{" "}
                {slot?.width} × {slot?.height} px. You&rsquo;ll compare before
                using it.
              </p>
            )}
            {canBackground && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Keeps your real product exactly as photographed and puts it on
                white, a colour or a transparent background
                {scenesAvailable ? ", or in a scene" : ""}.
              </p>
            )}
          </div>
        )}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
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

function FitWarning({ text }: { text: string }) {
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );
}
