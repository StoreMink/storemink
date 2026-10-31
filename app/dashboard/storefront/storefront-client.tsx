"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Check,
  Loader2,
  Paintbrush,
  Palette,
} from "lucide-react";
import { switchStoreTheme } from "@/app/actions/theme-actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ThemeCategory, ThemeIndustry } from "@/lib/themes/meta";
import {
  describeThemeSwitch,
  planThemeSwitch,
  type ThemeSwitchFacts,
} from "@/lib/themes/switch-rules";
import { CustomiseStorefrontButton } from "./customise-storefront-dialog";

export interface ThemeCard {
  id: string;
  name: string;
  description: string;
  previewImage: string;
  industries: ThemeIndustry[];
  /** The plan this theme needs, when it needs one ("Pro"). */
  minPlanName: string | null;
  /** The store's plan is below that. */
  locked: boolean;
  /** The demo store to preview, when it is healthy. */
  previewSlug: string | null;
  previewUnavailableReason: string | null;
}

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";
const LOCAL_DEV_ROOT = process.env.NEXT_PUBLIC_LOCAL_DEV_ROOT ?? "localtest.me";

/** A theme's demo store, on the same local root as this dashboard in
 *  development, and on the platform domain everywhere else (a custom-domain
 *  dashboard included: demos only live on StoreMink's domain). */
function demoUrl(slug: string): string {
  const { hostname, protocol, port } = window.location;
  const root =
    hostname === "localhost" || hostname.endsWith(".localhost")
      ? "localhost"
      : hostname === LOCAL_DEV_ROOT || hostname.endsWith(`.${LOCAL_DEV_ROOT}`)
        ? LOCAL_DEV_ROOT
        : null;
  return root
    ? `${protocol}//${slug}.${root}${port ? `:${port}` : ""}`
    : `https://${slug}.${ROOT_DOMAIN}`;
}

const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50";
const OUTLINE_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[rgba(17,24,39,0.14)] bg-white px-3.5 py-2 text-sm font-medium text-[#111827] transition-colors hover:border-[#111827] disabled:cursor-not-allowed disabled:opacity-50";

// Dashboard → Storefront. ★★ A THEME IS CHOSEN ONCE (owner, 31 Oct 2026).
// While the store has none (settings.themePending), the page is the empty
// state and the theme library, and choosing a theme goes through a confirm
// dialog written from the rules the server runs (lib/themes/switch-rules.ts).
// Once it has one, the library is gone: the page shows the theme with
// Customise storefront (a Mink AI redesign), the Website Builder and the
// store, and a Branding card, since Branding sits under Storefront.
export function StorefrontClient({
  current,
  currentId,
  library,
  categories,
  facts,
  canManage,
  canCustomise,
  canEditBranding,
  managedByOperators,
  unavailable,
}: {
  current: ThemeCard | null;
  currentId: string | null;
  /** The themes to choose from; empty once the store has its theme. */
  library: ThemeCard[];
  categories: ThemeCategory[];
  facts: ThemeSwitchFacts | null;
  canManage: boolean;
  /** May start a Mink AI redesign (Website Builder manage). */
  canCustomise: boolean;
  /** May open the Branding page. */
  canEditBranding: boolean;
  managedByOperators: boolean;
  unavailable: boolean;
}) {
  const router = useRouter();
  // ★ A store with no theme yet (settings.themePending, read by the server as
  // facts.firstTheme). Its storefront shows the "store in progress" page, so
  // nothing here may offer to customise or view a design that does not exist.
  const pending = facts?.firstTheme === true;
  const [filter, setFilter] = useState<ThemeIndustry | "all">("all");
  const [target, setTarget] = useState<ThemeCard | null>(null);
  const [replaceEdited, setReplaceEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(
    () =>
      library.filter(
        (theme) => filter === "all" || theme.industries.includes(filter),
      ),
    [library, filter],
  );

  // ★ The dialog reads the SAME rules the server runs (switch-rules.ts), so
  // it cannot promise one outcome while the switch does another.
  const lines =
    target && facts
      ? describeThemeSwitch(
          target.name,
          facts,
          planThemeSwitch(facts, { replaceEditedHomepage: replaceEdited }),
        )
      : [];

  function openConfirm(theme: ThemeCard) {
    setReplaceEdited(false);
    setTarget(theme);
  }

  async function confirmSwitch() {
    if (!target) return;
    setBusy(true);
    let result: Awaited<ReturnType<typeof switchStoreTheme>>;
    try {
      // The server refuses if the store has had a theme chosen since this
      // page loaded (another tab), so the dialog cannot promise a first
      // install that would not happen.
      result = await switchStoreTheme(target.id, {
        replaceEditedHomepage: replaceEdited,
      });
    } catch {
      result = {
        ok: false,
        error:
          "We couldn't reach StoreMink. Check your connection and try again.",
      };
    }
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setTarget(null);
    toast.success(`Your store now uses ${result.themeName}.`);
    if (result.warnings.length > 0) {
      // "In place", not "live": a first theme usually lands on a store that
      // has not opened yet, so nobody but the owner sees it so far.
      toast.warning(
        "Your new theme is in place, but some of its starting content couldn't be added. You can add it in the Website Builder.",
      );
    }
    router.refresh();
  }

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <h1>Storefront</h1>
        <p>
          {pending
            ? "Choose how your store looks to customers. You choose your theme once; your products, pages and settings stay yours."
            : "How your store looks to customers. Customise it with Mink AI, or edit any page in the Website Builder."}
        </p>
      </header>

      {unavailable && (
        <div className="mt-4 max-w-3xl rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          We couldn&apos;t read your store&apos;s theme just now. Reload the
          page to try again.
        </div>
      )}
      {managedByOperators && (
        <div className="mt-4 max-w-3xl rounded-xl border border-[#e5e5e5] bg-white p-4 text-sm text-[#5b6472]">
          This store&apos;s theme is managed by StoreMink and can&apos;t be
          changed here.
        </div>
      )}

      {/* ── Your theme ───────────────────────────────────────────── */}
      {/* Not drawn when the store couldn't be read: the banner above says so,
          and a card guessing at "no theme" would contradict it. */}
      {!unavailable && (
        <section className="mt-5 max-w-5xl" aria-labelledby="your-theme">
          <h2
            id="your-theme"
            className="mb-3 text-sm font-semibold text-[#111827]"
          >
            Your theme
          </h2>
          {pending ? (
            <div className="flex flex-col gap-4 rounded-xl border border-dashed border-[rgba(17,24,39,0.18)] bg-white p-5 sm:flex-row sm:items-center">
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#f4f4f6] text-[#5b6472]"
                aria-hidden="true"
              >
                <Paintbrush className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-base font-semibold text-[#111827]">
                  You haven&apos;t chosen a theme yet
                </p>
                <p className="mt-1 text-sm leading-6 text-[#5b6472]">
                  Until you do, your storefront shows a &ldquo;store in
                  progress&rdquo; page instead of your shop.{" "}
                  {canManage
                    ? "Choose a theme from the library below. You choose it once: after that you change how your store looks with Customise storefront and the Website Builder."
                    : "Someone who manages your storefront can choose one from the library below."}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col overflow-hidden rounded-xl border border-[#e5e5e5] bg-white sm:flex-row">
              <div className="relative aspect-[4/3] w-full shrink-0 bg-[#f4f4f6] sm:w-80">
                {current ? (
                  <Image
                    src={current.previewImage}
                    alt=""
                    fill
                    sizes="(max-width: 640px) 100vw, 320px"
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-[#9aa1ab]">
                    <Paintbrush className="h-8 w-8" aria-hidden="true" />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col justify-between gap-4 p-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-semibold text-[#111827]">
                      {current?.name ?? currentId ?? "No theme"}
                    </span>
                    {currentId && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[#111827]/5 px-2 py-0.5 text-[11px] font-semibold text-[#5b6472]">
                        <Check className="h-3 w-3" aria-hidden="true" /> In use
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm leading-6 text-[#5b6472]">
                    {current?.description ??
                      (currentId
                        ? "Your store uses a theme that is no longer in the library. It keeps working."
                        : "Your store doesn't use a theme from the library.")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canCustomise && (
                    <CustomiseStorefrontButton className={PRIMARY_BTN} />
                  )}
                  <Link
                    href="/dashboard/builder"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={canCustomise ? OUTLINE_BTN : PRIMARY_BTN}
                  >
                    Edit in Website Builder
                  </Link>
                  <a
                    href="/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={OUTLINE_BTN}
                  >
                    View your store
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Library ─────────────────────────────────────────────── */}
      {/* Only while the store has no theme: a theme is chosen once. */}
      {pending && (
        <section className="mt-8 max-w-5xl" aria-labelledby="theme-library">
          <h2
            id="theme-library"
            className="text-sm font-semibold text-[#111827]"
          >
            Theme library
          </h2>
          <p className="mt-1 text-sm text-[#5b6472]">
            Preview any theme on its demo store before you choose.
          </p>

          {categories.length > 2 && (
            <div
              className="mt-3 flex flex-wrap gap-2"
              role="group"
              aria-label="Filter themes by industry"
            >
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  aria-pressed={filter === category.id}
                  onClick={() => setFilter(category.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    filter === category.id
                      ? "border-[#111827] bg-[#111827] text-white"
                      : "border-[rgba(17,24,39,0.14)] bg-white text-[#374151] hover:border-[#111827]"
                  }`}
                >
                  {category.label}
                </button>
              ))}
            </div>
          )}

          {visible.length === 0 ? (
            <p className="mt-4 text-sm text-[#5b6472]">
              No themes match this filter.
            </p>
          ) : (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((theme) => (
                <li
                  key={theme.id}
                  className="flex flex-col overflow-hidden rounded-xl border border-[#e5e5e5] bg-white"
                >
                  <div className="relative aspect-[4/3] bg-[#f4f4f6]">
                    <Image
                      src={theme.previewImage}
                      alt=""
                      fill
                      sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 340px"
                      className="object-cover"
                    />
                    {theme.minPlanName && (
                      <span className="absolute left-3 top-3 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-[#111827]">
                        {theme.minPlanName} plan
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-3 p-4">
                    <div>
                      <h3 className="font-semibold text-[#111827]">
                        {theme.name}
                      </h3>
                      <p className="mt-1 line-clamp-2 text-sm leading-5 text-[#5b6472]">
                        {theme.description}
                      </p>
                    </div>
                    <div className="mt-auto flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={!theme.previewSlug}
                        title={
                          theme.previewSlug
                            ? `Preview ${theme.name}`
                            : (theme.previewUnavailableReason ?? undefined)
                        }
                        onClick={() => {
                          if (!theme.previewSlug) return;
                          window.open(
                            demoUrl(theme.previewSlug),
                            "_blank",
                            "noopener,noreferrer",
                          );
                        }}
                        className={OUTLINE_BTN}
                      >
                        {theme.previewSlug ? "Preview" : "No preview"}
                        {theme.previewSlug && (
                          <ArrowUpRight
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                      {theme.locked ? (
                        <Link href="/dashboard/plans" className={PRIMARY_BTN}>
                          Upgrade to {theme.minPlanName}
                        </Link>
                      ) : (
                        canManage && (
                          <button
                            type="button"
                            onClick={() => openConfirm(theme)}
                            className={PRIMARY_BTN}
                          >
                            Use this theme
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Branding ────────────────────────────────────────────── */}
      {/* Branding is part of Storefront (it sits under it in the sidebar). */}
      {canEditBranding && (
        <section className="mt-8 max-w-5xl" aria-labelledby="branding-card">
          <h2
            id="branding-card"
            className="mb-3 text-sm font-semibold text-[#111827]"
          >
            Branding
          </h2>
          <div className="flex flex-col gap-4 rounded-xl border border-[#e5e5e5] bg-white p-5 sm:flex-row sm:items-center">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#f4f4f6] text-[#5b6472]"
              aria-hidden="true"
            >
              <Palette className="h-5 w-5" />
            </div>
            <p className="min-w-0 flex-1 text-sm leading-6 text-[#5b6472]">
              Your logo, store name, colours, contact details, social links and
              brand voice.
            </p>
            <Link href="/dashboard/branding" className={OUTLINE_BTN}>
              Edit branding
            </Link>
          </div>
        </section>
      )}

      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Use {target?.name}?</DialogTitle>
            <DialogDescription>Here is what happens.</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-sm leading-6 text-[#374151]">
            {lines.map((line) => (
              <li key={line} className="flex gap-2">
                <span
                  className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-[#9aa1ab]"
                  aria-hidden="true"
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          {facts?.homepage === "edited" && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3 text-sm text-[#374151]">
              <input
                type="checkbox"
                checked={replaceEdited}
                onChange={(event) => setReplaceEdited(event.target.checked)}
                disabled={busy}
                className="mt-1 h-4 w-4 shrink-0 accent-[#111827]"
              />
              <span>
                Also replace my edited homepage with {target?.name}&apos;s. A
                copy of it is kept as a draft page first.
              </span>
            </label>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTarget(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void confirmSwitch()} disabled={busy}>
              {busy ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  Setting up…
                </>
              ) : (
                `Use ${target?.name ?? "theme"}`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
