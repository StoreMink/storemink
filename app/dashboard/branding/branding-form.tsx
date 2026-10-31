"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Lock } from "lucide-react";
import { toast } from "sonner";
import { saveStoreBranding } from "@/app/actions/store-branding";
import {
  saveBrandVoice,
  type BrandVoiceEditorData,
} from "@/app/actions/brand-voice-actions";
import type { StoreBrand } from "@/lib/store/brand";
import { ImageUpload } from "@/components/ui/image-upload";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import { BrandPreview } from "./brand-preview";
import { BrandVoiceSection } from "./brand-voice-form";
import { InstagramMark, WhatsappMark, YoutubeMark } from "./brand-icons";
import {
  brandDraftForSave,
  brandDraftFrom,
  brandingFormData,
  creditLineCopy,
  normalizeHex,
  sameBrandDraft,
  sameVoiceDraft,
  validateBrandDraft,
  voiceDraftForSave,
  voiceDraftFrom,
  type BrandDraft,
  type BrandFieldErrors,
  type VoiceDraft,
} from "./branding-state";
import "./branding.css";

const SAVE_FAILED = "Could not save branding. Please try again.";
const VOICE_SAVE_FAILED = "Could not save your brand voice. Please try again.";

/**
 * The Branding page: logo and colour, store details, contact details, social
 * links, the footer lines and the brand voice, beside a live preview of where
 * each lands on the storefront.
 *
 * ★ ONE SAVE FOR THE WHOLE PAGE. Every field is controlled and compared with
 * what was last saved; the moment anything differs, the dashboard's contextual
 * save bar appears with Discard and Save. Save sends only the parts that
 * changed (branding through saveStoreBranding, the guide through
 * saveBrandVoice), and a part that fails keeps its changes and says why while
 * the part that saved is kept as saved.
 */
export function BrandingForm({
  initial,
  voice: initialVoice,
  canManage,
  removeBadge,
}: {
  initial: StoreBrand;
  voice: Pick<BrandVoiceEditorData, "content" | "structured">;
  canManage: boolean;
  /** Whether the store's plan removes the "Powered by StoreMink" badge;
   *  null when the plan could not be read. */
  removeBadge: boolean | null;
}) {
  const router = useRouter();
  const [savedBrand, setSavedBrand] = useState<BrandDraft>(() =>
    brandDraftFrom(initial),
  );
  const [draft, setDraft] = useState<BrandDraft>(savedBrand);
  const [savedVoice, setSavedVoice] = useState<VoiceDraft>(() =>
    voiceDraftFrom(initialVoice),
  );
  const [voice, setVoice] = useState<VoiceDraft>(savedVoice);
  // What the hex box shows. It may hold a half-typed colour; the draft only
  // takes it once it reads as a whole hex.
  const [colorText, setColorText] = useState(savedBrand.primaryColor);
  const [errors, setErrors] = useState<BrandFieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const brandChanged = !sameBrandDraft(draft, savedBrand);
  const voiceChanged = !sameVoiceDraft(voice, savedVoice);
  const dirty = canManage && (brandChanged || voiceChanged);

  // Nothing here autosaves, so a reload or tab close asks first.
  useUnsavedChangesWarning(dirty);

  function set<K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (key === "name" || key === "email") {
      clearError(key as keyof BrandFieldErrors);
    }
  }

  function clearError(field: keyof BrandFieldErrors) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function setColor(value: string) {
    setColorText(value);
    const hex = normalizeHex(value);
    if (hex) set("primaryColor", hex);
  }

  function discard() {
    setDraft(savedBrand);
    setVoice(savedVoice);
    setColorText(savedBrand.primaryColor);
    setErrors({});
    setSaveError(null);
  }

  async function save() {
    if (!canManage || saving || generating) return;
    if (!brandChanged && !voiceChanged) {
      setSaveError(null);
      return;
    }
    if (brandChanged) {
      const found = validateBrandDraft(draft);
      if (found.name || found.email) {
        setErrors(found);
        setSaveError("Fix the highlighted fields, then save.");
        (found.name ? nameRef : emailRef).current?.focus();
        return;
      }
    }

    setSaving(true);
    setSaveError(null);
    const failures: string[] = [];
    const saved: string[] = [];

    if (brandChanged) {
      const sentFrom = draft;
      const sent = brandDraftForSave(draft);
      try {
        const res = await saveStoreBranding(brandingFormData(sent));
        if (res.error) {
          failures.push(res.error);
        } else {
          saved.push("branding");
          setSavedBrand(sent);
          // Show the values as they were stored (trimmed, links given a
          // scheme), unless something was typed while the save ran.
          setDraft((cur) => (sameBrandDraft(cur, sentFrom) ? sent : cur));
          setColorText(sent.primaryColor);
        }
      } catch {
        failures.push(SAVE_FAILED);
      }
    }

    if (voiceChanged) {
      const sentFrom = voice;
      const sent = voiceDraftForSave(voice);
      try {
        const res = await saveBrandVoice({
          content: sent.content,
          structured: sent.answers,
        });
        if (res.error) {
          failures.push(res.error);
        } else {
          saved.push("voice");
          setSavedVoice(sent);
          setVoice((cur) => (sameVoiceDraft(cur, sentFrom) ? sent : cur));
        }
      } catch {
        failures.push(VOICE_SAVE_FAILED);
      }
    }

    setSaving(false);
    if (failures.length > 0) setSaveError(failures.join(" "));
    if (saved.length > 0) {
      toast.success(
        saved.length === 2
          ? "Branding and brand voice saved."
          : saved[0] === "voice"
            ? "Brand voice saved. Mink AI now writes in it."
            : "Branding saved.",
      );
    }
    // The sidebar shows the store's name; let the server parts catch up.
    if (saved.includes("branding")) router.refresh();
  }

  const creditCopy = creditLineCopy(removeBadge, draft.creditLine);
  const disabled = !canManage;

  return (
    <form
      className="brandingForm"
      data-dirty={dirty ? "true" : undefined}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {dirty && (
        <div className="dash-savebar">
          <div className="dash-savebar-msg">
            <span className="dash-savebar-dot" aria-hidden />
            <span>
              Unsaved changes
              {saveError && (
                <span className="dash-savebar-error" role="alert">
                  {saveError}
                </span>
              )}
            </span>
          </div>
          <div className="dash-savebar-actions">
            <button
              type="button"
              className="dash-sb-btn"
              onClick={discard}
              disabled={saving}
            >
              Discard
            </button>
            <button
              type="submit"
              className="dash-sb-btn is-primary"
              disabled={saving || generating}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="dash-page-enter brandingPage">
        <header className="dash-page-header row brandingHeader">
          <div>
            <h1>Branding</h1>
            <p>
              Your logo, colour, store details and the voice Mink AI writes in.
            </p>
          </div>
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="dash-btn dash-btn-ghost"
          >
            <ExternalLink size={14} />
            View your store
          </a>
        </header>

        {disabled && (
          <p className="brandingNotice">
            <Lock size={14} aria-hidden />
            You can view these details. Ask your store owner for permission to
            change them.
          </p>
        )}

        <div className="brandingLayout">
          <div className="brandingMain">
            <Card
              id="logo"
              title="Logo and colour"
              sub="How customers recognise your store."
            >
              <div className="brandingLogoRow">
                <div className="brandingField">
                  <span className="brandingLabel" id="logo-label">
                    Logo
                  </span>
                  {canManage ? (
                    <div
                      className="brandingLogoBox"
                      role="group"
                      aria-labelledby="logo-label"
                    >
                      <ImageUpload
                        defaultImage={draft.logoUrl}
                        onUploadSuccess={(url) => set("logoUrl", url)}
                        folder="dashboard-uploads"
                        spec="logo"
                      />
                    </div>
                  ) : draft.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={draft.logoUrl}
                      alt="Store logo"
                      className="brandingLogoStatic"
                    />
                  ) : (
                    <p className="brandingHint">No logo yet.</p>
                  )}
                  <p className="brandingHint">
                    Shown in your header, footer and browser tab.
                  </p>
                </div>
              </div>

              <div className="brandingField">
                <label htmlFor="primaryColor">Primary colour</label>
                <div className="brandingColor">
                  <label
                    className="brandingSwatch"
                    style={{ background: draft.primaryColor }}
                  >
                    <span className="sr-only">Pick a colour</span>
                    <input
                      type="color"
                      value={draft.primaryColor}
                      onChange={(e) => setColor(e.target.value)}
                      disabled={disabled}
                    />
                  </label>
                  <input
                    id="primaryColor"
                    className="dash-input brandingHex"
                    value={colorText}
                    onChange={(e) => setColor(e.target.value)}
                    onBlur={() => setColorText(draft.primaryColor)}
                    disabled={disabled}
                    maxLength={7}
                    spellCheck={false}
                    autoComplete="off"
                    aria-describedby="primaryColor-hint"
                  />
                </div>
                <p className="brandingHint" id="primaryColor-hint">
                  Used for buttons, links and highlights. Type a hex code or
                  pick one.
                </p>
              </div>
            </Card>

            <Card
              id="details"
              title="Store details"
              sub="Your name and the words that introduce your store."
            >
              <Field
                id="name"
                label="Store name"
                error={errors.name}
                hint="Shown in your store's header, browser tab and emails."
              >
                <input
                  id="name"
                  ref={nameRef}
                  className="dash-input"
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  disabled={disabled}
                  required
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={
                    errors.name ? "name-error name-hint" : "name-hint"
                  }
                />
              </Field>
              <Field
                id="tagline"
                label="Tagline"
                hint="Shown on your shop page and in search results."
              >
                <input
                  id="tagline"
                  className="dash-input"
                  value={draft.tagline}
                  onChange={(e) => set("tagline", e.target.value)}
                  disabled={disabled}
                  aria-describedby="tagline-hint"
                />
              </Field>
              <Field
                id="blurb"
                label="About your store"
                hint="A sentence or two shown in your store's footer, under your logo."
              >
                <textarea
                  id="blurb"
                  className="dash-input brandingTextarea"
                  value={draft.blurb}
                  onChange={(e) => set("blurb", e.target.value)}
                  disabled={disabled}
                  rows={3}
                  aria-describedby="blurb-hint"
                />
              </Field>
            </Card>

            <Card
              id="contact"
              title="Contact details"
              sub="Shown in your store's footer so customers can reach you."
            >
              <div className="brandingGrid two">
                <Field id="email" label="Email" error={errors.email}>
                  <input
                    id="email"
                    ref={emailRef}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    className="dash-input"
                    value={draft.email}
                    onChange={(e) => set("email", e.target.value)}
                    disabled={disabled}
                    aria-invalid={errors.email ? true : undefined}
                    aria-describedby={errors.email ? "email-error" : undefined}
                  />
                </Field>
                <Field id="phone" label="Phone">
                  <input
                    id="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    className="dash-input"
                    value={draft.phone}
                    onChange={(e) => set("phone", e.target.value)}
                    disabled={disabled}
                  />
                </Field>
                <Field id="hours" label="Opening hours" className="wide">
                  <input
                    id="hours"
                    className="dash-input"
                    value={draft.hours}
                    onChange={(e) => set("hours", e.target.value)}
                    disabled={disabled}
                  />
                </Field>
              </div>
            </Card>

            <Card
              id="social"
              title="Social links"
              sub="Icons in your store's footer link to these. Leave any empty to hide its icon."
            >
              <SocialField
                id="instagram"
                label="Instagram"
                icon={<InstagramMark />}
                value={draft.instagram}
                placeholder="instagram.com/…"
                disabled={disabled}
                onChange={(v) => set("instagram", v)}
              />
              <SocialField
                id="youtube"
                label="YouTube"
                icon={<YoutubeMark />}
                value={draft.youtube}
                placeholder="youtube.com/@…"
                disabled={disabled}
                onChange={(v) => set("youtube", v)}
              />
              <SocialField
                id="whatsapp"
                label="WhatsApp"
                icon={<WhatsappMark />}
                value={draft.whatsapp}
                placeholder="wa.me/…"
                disabled={disabled}
                onChange={(v) => set("whatsapp", v)}
              />
            </Card>

            <Card
              id="footer"
              title="Footer"
              sub="The two small lines at the very bottom of every page."
            >
              <Field
                id="legalName"
                label="Legal name"
                hint={`Shown in the copyright line: © ${new Date().getFullYear()} ${
                  draft.legalName.trim() || draft.name.trim() || "Your store"
                }. Leave it empty to use your store name.`}
              >
                <input
                  id="legalName"
                  className="dash-input"
                  value={draft.legalName}
                  onChange={(e) => set("legalName", e.target.value)}
                  disabled={disabled}
                  aria-describedby="legalName-hint"
                />
              </Field>
              <Field id="creditLine" label="Credit line" hint={creditCopy.hint}>
                <input
                  id="creditLine"
                  className="dash-input"
                  value={draft.creditLine}
                  onChange={(e) => set("creditLine", e.target.value)}
                  placeholder={creditCopy.placeholder}
                  disabled={disabled}
                  aria-describedby="creditLine-hint"
                />
              </Field>
            </Card>

            <BrandVoiceSection
              voice={voice}
              onChange={setVoice}
              canManage={canManage}
              onGeneratingChange={setGenerating}
            />
          </div>

          <aside className="brandingAside" aria-labelledby="preview-title">
            <div className="dash-card brandingCard">
              <header className="dash-card-header">
                <div>
                  <h2 className="dash-card-title" id="preview-title">
                    Preview
                  </h2>
                  <p className="dash-card-sub">
                    Where these details show on your store.
                  </p>
                </div>
              </header>
              <div className="brandingPreviewBody">
                <BrandPreview draft={draft} removeBadge={removeBadge} />
              </div>
            </div>
            <p className="brandingAsideNote">
              Your theme decides the exact fonts and layout.
            </p>
          </aside>
        </div>
      </div>
    </form>
  );
}

function Card({
  id,
  title,
  sub,
  children,
}: {
  id: string;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <section className="dash-card brandingCard" aria-labelledby={`${id}-title`}>
      <header className="dash-card-header">
        <div>
          <h2 className="dash-card-title" id={`${id}-title`}>
            {title}
          </h2>
          <p className="dash-card-sub">{sub}</p>
        </div>
      </header>
      <div className="dash-card-body brandingCardBody">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`brandingField${className ? ` ${className}` : ""}`}
      data-invalid={error ? "true" : undefined}
    >
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <p className="brandingError" id={`${id}-error`}>
          {error}
        </p>
      )}
      {hint && (
        <p className="brandingHint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function SocialField({
  id,
  label,
  icon,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="brandingField">
      <label htmlFor={id}>{label}</label>
      <div className="brandingIconInput">
        <span className="brandingInputIcon">{icon}</span>
        <input
          id={id}
          className="dash-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
