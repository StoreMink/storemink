"use client";

import { useState } from "react";
import { saveStoreBranding } from "@/app/actions/store-branding";
import type { StoreBrand } from "@/lib/store/brand";
import { isDefaultCreditWords } from "@/lib/store/footer-credit";
import { ImageUpload } from "@/components/ui/image-upload";
import "./branding.css";

/** The Basic and Pro placeholder: a line of the store's own, never the badge's. */
const OWN_LINE_PLACEHOLDER = "e.g. Made with care by Acme Foods";

/**
 * What the Credit line field says, by whether the store's plan removes
 * StoreMink's "Powered by" badge (PLAN_LIMITS.removeBadge for its effective
 * plan, read by the page) and by what the field holds. The storefront follows
 * the same rule (lib/store/footer-credit.ts): Free always shows the badge,
 * Basic and Pro show the store's own line or nothing. ★ On Basic and Pro the
 * placeholder is an example of a line of the store's own: the badge's words
 * there would suggest the badge still shows when the field is empty. ★ And a
 * line that is only the badge's words shows NOTHING there (isDefaultCreditWords,
 * the storefront's own test), so the hint says so rather than promising it
 * shows: the Free placeholder suggests exactly those words, so a store that
 * typed them on Free carries them into Basic or Pro. `null` is a plan that
 * could not be read, so the hint states both rules.
 */
function creditLineCopy(
  removeBadge: boolean | null,
  creditLine: string,
): {
  hint: string;
  placeholder?: string;
} {
  if (removeBadge === false) {
    return {
      hint: "Your store shows Powered by StoreMink here on the Free plan. On Basic or Pro you can show your own line, or nothing.",
      placeholder: "Powered by StoreMink",
    };
  }
  if (removeBadge === true) {
    if (isDefaultCreditWords(creditLine)) {
      return {
        hint: "These are the words of StoreMink's badge, so nothing shows at the very bottom of your store. Type a line of your own, or leave it empty.",
        placeholder: OWN_LINE_PLACEHOLDER,
      };
    }
    return {
      hint: "Shown at the very bottom of your store. Leave it empty to show nothing.",
      placeholder: OWN_LINE_PLACEHOLDER,
    };
  }
  return {
    hint: "Shown at the very bottom of your store on Basic and Pro. On the Free plan, Powered by StoreMink shows here instead.",
  };
}

export function BrandingForm({
  initial,
  canManage,
  removeBadge,
}: {
  initial: StoreBrand;
  canManage: boolean;
  /** Whether the store's plan removes the "Powered by StoreMink" badge;
   *  null when the plan could not be read. */
  removeBadge: boolean | null;
}) {
  const [saving, setSaving] = useState(false);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl || "");
  // What the Credit line field holds right now, for its hint only (the field
  // itself stays uncontrolled and is read from the form on save).
  const [creditLine, setCreditLine] = useState(initial.creditLine ?? "");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canManage) return;
    setSaving(true);
    setStatus(null);
    const res = await saveStoreBranding(new FormData(e.currentTarget));
    setSaving(false);
    setStatus(
      res.error
        ? { ok: false, msg: res.error }
        : { ok: true, msg: "Branding saved." },
    );
  }

  const field = (
    name: string,
    label: string,
    value: string | null,
    opts: {
      type?: string;
      placeholder?: string;
      full?: boolean;
      hint?: string;
      onChange?: (value: string) => void;
    } = {},
  ) => (
    <div className={`brandingField${opts.full ? " full" : ""}`}>
      <label htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        type={opts.type ?? "text"}
        defaultValue={value ?? ""}
        placeholder={opts.placeholder}
        disabled={!canManage}
        aria-describedby={opts.hint ? `${name}-hint` : undefined}
        onChange={
          opts.onChange ? (e) => opts.onChange?.(e.target.value) : undefined
        }
      />
      {opts.hint && (
        <p className="brandingHint" id={`${name}-hint`}>
          {opts.hint}
        </p>
      )}
    </div>
  );
  const creditCopy = creditLineCopy(removeBadge, creditLine);

  return (
    <form className="brandingPage" onSubmit={onSubmit}>
      <h1>Branding</h1>
      <p className="lead">
        How your store looks to customers - logo, name, colours, contact details
        and social links.
      </p>

      <div className="brandingSection">
        <h2>Identity</h2>
        <div className="brandingGrid">
          {field("name", "Store name", initial.name)}
          {field("tagline", "Tagline", initial.tagline, {
            placeholder: "Short line shown in the browser tab",
          })}
          <div className="brandingField full">
            <label>Logo</label>
            <input type="hidden" name="logoUrl" value={logoUrl} />
            <ImageUpload
              defaultImage={logoUrl}
              onUploadSuccess={setLogoUrl}
              folder="dashboard-uploads"
              spec="logo"
            />
          </div>
          <div className="brandingField">
            <label htmlFor="primaryColor">Primary colour</label>
            <input
              id="primaryColor"
              name="primaryColor"
              type="color"
              defaultValue={initial.primaryColor}
              disabled={!canManage}
            />
          </div>
        </div>
      </div>

      <div className="brandingSection">
        <h2>Footer</h2>
        <div className="brandingGrid">
          {field("blurb", "About blurb", initial.blurb, {
            placeholder: "A sentence about your brand",
            full: true,
          })}
          {field("legalName", "Legal name (copyright)", initial.legalName, {
            placeholder: "Acme Foods Pvt. Ltd.",
          })}
          {field("creditLine", "Credit line", initial.creditLine, {
            placeholder: creditCopy.placeholder,
            hint: creditCopy.hint,
            onChange: setCreditLine,
          })}
        </div>
      </div>

      <div className="brandingSection">
        <h2>Contact</h2>
        <div className="brandingGrid">
          {field("email", "Email", initial.email, { type: "email" })}
          {field("phone", "Phone", initial.phone, {
            placeholder: "+91 98765 43210",
          })}
          {field("hours", "Hours", initial.hours, {
            placeholder: "Mon to Sat, 10am to 6pm IST",
          })}
        </div>
      </div>

      <div className="brandingSection">
        <h2>Social links</h2>
        <div className="brandingGrid">
          {field("instagram", "Instagram URL", initial.social.instagram)}
          {field("youtube", "YouTube URL", initial.social.youtube)}
          {field("whatsapp", "WhatsApp link", initial.social.whatsapp, {
            placeholder: "https://wa.me/91…",
          })}
        </div>
      </div>

      {canManage && (
        <div className="brandingBar">
          <button className="brandingSave" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save branding"}
          </button>
          {status && (
            <span className={`brandingStatus ${status.ok ? "ok" : "bad"}`}>
              {status.msg}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
