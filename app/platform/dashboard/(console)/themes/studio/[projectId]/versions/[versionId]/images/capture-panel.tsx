import { stopText } from "../../../../studio-ui";

// ---------------------------------------------------------------------------
// The catalogue pictures of one design, at the top of the Pictures tab (wave
// TS-2, builder 2C): the card the theme catalog shows and the desktop and
// phone screenshots, each with where it came from.
//
// ★ NO "CAPTURE CATALOGUE PICTURES" BUTTON (plan section 4, "What of today's
// UI goes"). Every final check takes these pictures from the design's
// preview store in a real browser, so there is nothing to capture by hand;
// with the browser job switched off (local development), they are uploaded
// in the picture list below like any other picture.
//
// Server-safe and hook-free: it only shows what the server read.
// ---------------------------------------------------------------------------

/** A capture's stop code in words (the theme page's own sentences,
 * studio-words.ts), so a capture that failed is never a bare code. */
export function captureErrorText(code: string | null): string {
  return stopText(code, "capture");
}

export interface CatalogSlotSummary {
  id: string;
  label: string;
  url: string | null;
  placeholder: boolean;
  /** Taken by a check from the preview store (capture-core.ts
   * CAPTURED_LICENSE_NOTE), not uploaded. */
  captured: boolean;
}

/** Where one catalogue picture came from, in words. */
export function catalogPictureState(slot: CatalogSlotSummary): string {
  if (slot.placeholder) return "Still a placeholder";
  return slot.captured ? "Taken by the checks" : "Uploaded";
}

export function CatalogPictures({
  slots,
  captureEnabled,
}: {
  slots: readonly CatalogSlotSummary[];
  /** The browser job that takes them is deployed here. */
  captureEnabled: boolean;
}) {
  if (slots.length === 0) return null;
  return (
    <section
      className="dash-card"
      aria-labelledby="studio-catalog-pictures-title"
    >
      <div className="dash-card-header">
        <h2 id="studio-catalog-pictures-title" className="dash-card-title">
          In the theme catalog
        </h2>
      </div>
      <div className="dash-card-body grid gap-3">
        <p className="studio-muted text-sm">
          {captureEnabled
            ? "The theme catalog shows this card and these screenshots. Every final check takes them again from the preview store."
            : "Capture is switched off on this deployment, so upload them in the list below."}
        </p>
        <ul className="flex flex-wrap gap-3">
          {slots.map((slot) => (
            <li key={slot.id} className="grid w-40 gap-1 text-xs">
              <div className="flex h-24 items-center justify-center overflow-hidden rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface-2)]">
                {slot.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={slot.url}
                    alt={slot.label}
                    loading="lazy"
                    decoding="async"
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <span className="studio-muted">No picture</span>
                )}
              </div>
              <p>
                <span className="font-medium">{slot.label}</span>
                <br />
                <span className="studio-muted">
                  {catalogPictureState(slot)}
                </span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
