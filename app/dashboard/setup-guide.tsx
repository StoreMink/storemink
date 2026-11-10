"use client";

import { useId, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  CreditCard,
  ExternalLink,
  FileText,
  Globe,
  ImageIcon,
  LayoutTemplate,
  ListChecks,
  Loader2,
  Lock,
  Package,
  PackageX,
  Palette,
  Receipt,
  RefreshCw,
  Rocket,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import {
  launchStore,
  regenerateStorefrontPassword,
} from "@/app/actions/launch-actions";
import type { LaunchChecklistItem } from "@/lib/store/launch-checklist-rules";
import styles from "./setup-guide.module.css";

// The phone library and Firebase's phone sign-in load only when somebody opens
// the mobile task, never with Dashboard Home itself.
const VerifyPhoneForm = dynamic(
  () => import("./components/verify-phone-form").then((m) => m.VerifyPhoneForm),
  { ssr: false, loading: () => <div className="h-24" aria-hidden /> },
);

/** The icon an OPEN task shows in place of its circle. Decoration only: an
 *  unknown key keeps the plain circle. */
const TASK_ICONS: Record<string, LucideIcon> = {
  phone: Smartphone,
  theme: Palette,
  products: Package,
  business: Building2,
  policies: FileText,
  homepage: LayoutTemplate,
  logo: ImageIcon,
  samples: PackageX,
  payments: CreditCard,
  gst: Receipt,
  domain: Globe,
};

/* ★ Everything below is laid out by the CARD's width, never the screen's.
   The card shares its row with the sidebar and the Mink AI panel, so on a
   wide screen it can be as narrow as ~230px. The root is a size container
   and every side-by-side layout uses a container variant:
     base         compact: everything stacks (a phone, a squeezed card)
     @min-[19rem] room to indent the password and a step's button under
                  their titles
     @sm  384px   roomier padding; a grouped task's count beside its title
     @lg  512px   a step's button beside it; panels align under the title
     @xl  576px   Go live beside the password; a task's one button beside
                  its description */

/** Keyboard focus. An outline rather than a ring: the dashboard's button
 *  rules set box-shadow from an unlayered stylesheet, which would hide a
 *  Tailwind ring on every `dash-btn`. */
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dash-accent)]";

/** The card itself: a larger radius and layered depth (a contact shadow and a
 *  soft indigo glow beneath) so it reads as the hero of Dashboard Home. `!`
 *  because dashboard.css is unlayered and beats Tailwind utilities. */
const CARD_DEPTH =
  "rounded-[16px]! shadow-[0_1px_2px_rgba(16,24,40,0.05),0_4px_10px_-4px_rgba(16,24,40,0.06),0_22px_44px_-28px_rgba(79,70,229,0.45)]!";

/* ---------- The aurora hero ---------- */

/** The hero's two rows (the password strip, the progress) share one left
 *  column as wide as the progress ring, so the lock and the ring sit on one
 *  axis and the text beside them starts at one left edge.
 *
 *  ★ The numbers are tied to the task list's: the hero's padding, ring and gap
 *  put the ring's centre on the task icons' centre and the hero's text on the
 *  task titles' left edge, at every width.
 *    compact  list 18px + 40px icon slot + 10px gap: centre 38, titles at 68
 *             hero 16px + 44px ring + 8px gap:       centre 38, text at 68
 *    @sm      list 24px + 48px icon slot + 12px gap: centre 48, titles at 84
 *             hero 22px + 52px ring + 10px gap:      centre 48, text at 84
 *  Change one side and the other must move with it. */
const HERO_SLOT = "w-11 @sm:w-13";
const HERO_ROW =
  "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 pr-4 pl-4 @sm:gap-x-2.5 @sm:pr-5 @sm:pl-[22px] @xl:pr-6";

/** Secondary text on the aurora band: a step darker than the dashboard's
 *  text-2 so it keeps 4.5:1 over the tinted wash. */
const HERO_MUTED = "text-[#4b5563]";

/** The lock, a glassy tile on the wash. */
const LOCK_TILE =
  "flex h-9 w-9 items-center justify-center rounded-[11px] bg-white/85 text-[var(--dash-accent)] ring-1 ring-[rgba(17,24,39,0.08)] shadow-[inset_0_1px_0_#fff,0_1px_2px_rgba(16,24,40,0.06),0_8px_16px_-10px_rgba(79,70,229,0.55)] @sm:h-10 @sm:w-10 @sm:rounded-[12px]";

/** The password itself, set like a key on a glass chip. */
const PASSWORD_CHIP =
  "rounded-md bg-white/90 px-2 py-0.5 font-mono text-[12.5px] tracking-[0.06em] text-[var(--dash-text)] ring-1 ring-[rgba(17,24,39,0.1)] shadow-[inset_0_1px_0_#fff,0_1px_1px_rgba(16,24,40,0.04)]";

/** Copy, New and Preview: quiet text actions that gain a glassy chip on hover.
 *  At least 28px tall with a mouse, 44px on a touch screen. */
const HERO_ACTION = `inline-flex min-h-7 pointer-coarse:min-h-11 items-center gap-1 rounded-md px-1 font-medium ${HERO_MUTED} transition-colors hover:bg-white/80 hover:text-[var(--dash-text)] disabled:opacity-50 @sm:px-1.5 ${FOCUS_RING}`;

/** Go live, the card's one big moment: indigo to violet, a top highlight, a
 *  soft indigo halo and a coloured glow, so a ready store sees it change even
 *  with motion turned off. Until then it is a quiet grey well (no gradient,
 *  full opacity) that cannot be mistaken for a button that works, since on a
 *  phone it runs the card's full width. */
const GO_LIVE =
  "min-h-10 px-[18px]! text-[13.5px]! font-semibold! bg-[linear-gradient(135deg,#4f46e5_0%,#6d28d9_100%)]! shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_0_0_4px_rgba(99,102,241,0.16),0_1px_2px_rgba(16,24,40,0.16),0_10px_22px_-8px_rgba(91,33,182,0.6)]! enabled:hover:brightness-110 disabled:bg-none! disabled:bg-[#eceef4]! disabled:text-[#5b6472]! disabled:opacity-100! disabled:shadow-[inset_0_0_0_1px_rgba(17,24,39,0.06)]!";

/** Where Go live sits: under the password strip at full width, until the card
 *  is wide enough to hold it beside the strip. */
const GO_LIVE_PLACE =
  "col-span-2 row-start-3 mt-3 w-full @xl:col-span-1 @xl:col-start-3 @xl:row-span-2 @xl:row-start-1 @xl:mt-0 @xl:w-auto";

/* ---------- The task list ---------- */

/** A task's icon column, and the left edge of its title (row padding + icon
 *  column + gap), so its description and button line up under the title. */
const ICON_SLOT = "w-10 @sm:w-12";
const TITLE_INDENT = "pl-[60px] @sm:pl-[72px]";

/** The open task: a softly tinted panel with a hairline, a gentle indigo glow
 *  and a 3px gradient bar on its left edge. A second column appears once the
 *  card is wide, so a single button can sit beside the title and description. */
const OPEN_ROW =
  "my-1 grid grid-cols-1 bg-[linear-gradient(180deg,rgba(99,102,241,0.08)_0%,rgba(99,102,241,0.035)_100%)] ring-1 ring-inset ring-[rgba(79,70,229,0.16)] shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_24px_-18px_rgba(79,70,229,0.5)] before:pointer-events-none before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full before:bg-[linear-gradient(180deg,#6366f1_0%,#7c3aed_100%)] @xl:grid-cols-[minmax(0,1fr)_auto]";

/** The open task's icon tile: indigo to violet with a white icon. */
const OPEN_TILE =
  "flex h-7 w-7 items-center justify-center rounded-[9px] bg-[linear-gradient(135deg,#6366f1_0%,#7c3aed_100%)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_6px_14px_-6px_rgba(99,102,241,0.75)] @sm:h-8 @sm:w-8 @sm:rounded-[10px]";

/** An unfinished task's or step's hollow ring, dark enough for 3:1 on white
 *  and on the hover tint. The chevron uses the same grey. */
const HOLLOW_RING = "rounded-full border-[1.5px] border-[#7a8291]";
const CHEVRON = "h-4 w-4 shrink-0 text-[#7a8291]";

/** A finished title: muted and struck through, still 4.5:1. */
const DONE_TITLE =
  "text-[var(--dash-text-2)] line-through decoration-[#b6bcc6]";

/** A grouped task's "n of m": a white pill while the task is open, plain
 *  text while it is folded. */
const COUNT_OPEN =
  "rounded-full bg-white px-2 text-[11.5px] font-semibold text-[var(--dash-accent-hover)] ring-1 ring-[rgba(79,70,229,0.2)]";
const COUNT_FOLDED = "text-[12px] font-medium text-[var(--dash-text-2)]";

/** White inset panels inside the open task (the steps, the mobile form),
 *  lifted off the tinted row by a hairline and a contact shadow. */
const INNER_PANEL =
  "rounded-[10px] bg-white ring-1 ring-[rgba(17,24,39,0.08)] shadow-[0_1px_2px_rgba(16,24,40,0.05)]";

/** Where the mobile form and a task's steps sit: the full width of the row
 *  while the card is compact, under the title once it is wide. */
const PANEL_PLACE =
  "px-2.5 pb-3 @sm:px-3 @sm:pb-3.5 @lg:pr-4 @lg:pl-[72px] @xl:col-span-2 @xl:row-start-3";

/** What opens inside a task settles in from just above. One-shot, and only
 *  for anyone who has not asked the system for less motion. */
const REVEAL =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-300";

/** A step: its mark, its title, and (when the steps are on different pages)
 *  its own button in a third column once the card is wide. */
const STEP_ROW =
  "grid min-h-11 grid-cols-[20px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2 px-3 py-2.5 @sm:gap-x-3 @sm:px-3.5 @lg:grid-cols-[20px_minmax(0,1fr)_auto]";

/** A step's own button: the step's full width at the narrowest, under the
 *  title once there is room for its label, beside the title from @lg. */
const STEP_BUTTON =
  "col-span-2 w-full @min-[19rem]:col-span-1 @min-[19rem]:col-start-2 @min-[19rem]:w-auto @min-[19rem]:justify-self-start @lg:col-start-3";

/** The card's primary buttons: a gentle top-to-bottom indigo gradient, a 1px
 *  inner highlight and a soft coloured shadow. Both ends of the gradient keep
 *  white text above 5:1. */
const PRIMARY_GLOSS =
  "bg-[linear-gradient(180deg,#5a52ec_0%,#4338ca_100%)]! shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(16,24,40,0.14),0_6px_14px_-6px_rgba(79,70,229,0.6)]! hover:brightness-110";

/**
 * The Shopify-shaped setup guide: ONE card. Its head carries what the owner
 * is waiting on (the password that keeps the shop private, and Go live); its
 * body is the required tasks as an accordion in which exactly one task — the
 * first unfinished one — is open, showing what to do and a button that goes
 * there. Recommended tasks exist only once the required ones are all done,
 * and fold away so the card never reads as a wall.
 *
 * ★ A grouped task (business + delivery, the four policies) is ONE row with
 * its steps listed inside, each with its own tick, so the card stays five
 * rows long without hiding a single requirement. Steps that share a page
 * share one button; steps on different pages each get their own.
 *
 * Every tick is computed server-side from the store's own rows and handed in;
 * the client decides nothing about completion. Everything it DOES goes through
 * a server action that re-checks who is pressing and whether the checklist is
 * really complete.
 */
export function SetupGuide({
  items,
  requiredDone,
  requiredTotal,
  ready,
  missing,
  canLaunch,
  ownerCanVerifyPhone = false,
  password,
  previewUrl,
}: {
  items: LaunchChecklistItem[];
  requiredDone: number;
  requiredTotal: number;
  ready: boolean;
  missing: string[];
  canLaunch: boolean;
  /** The viewer is this store's owner, so the mobile task verifies in place. */
  ownerCanVerifyPhone?: boolean;
  password: string | null;
  previewUrl: string;
}) {
  const router = useRouter();
  const required = items.filter((i) => i.required);
  const recommended = items.filter((i) => !i.required);
  const recommendedDone = recommended.filter((i) => i.done).length;
  const firstOpen = required.find((i) => !i.done)?.key ?? null;
  const [open, setOpen] = useState<string | null>(firstOpen);
  const [showRecommended, setShowRecommended] = useState(false);
  const pct = Math.round((requiredDone / Math.max(requiredTotal, 1)) * 100);

  return (
    <section
      className={`dash-card @container overflow-hidden! p-0 ${CARD_DEPTH}`}
    >
      {/* ★ The aurora hero: the password strip, Go live and the progress
          share one band over a soft wash, so the card's head reads as one
          piece and the list below sits on clean white. */}
      <div className="relative isolate">
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] ${styles.aurora}`}
        >
          <div className={styles.ribbon} />
          {/* The dot grid is a flourish for a roomy card only. */}
          <div className={`absolute inset-0 hidden @sm:block ${styles.dots}`} />
          <div className={styles.seam} />
        </div>

        <GoLiveHead
          ready={ready}
          missing={missing}
          canLaunch={canLaunch}
          password={password}
          previewUrl={previewUrl}
        />

        {/* The heading comes first for screen readers; the grid draws the
            ring to its left, on the same axis as the lock above. */}
        <div className={`${HERO_ROW} pt-4 pb-4 @sm:pt-5 @sm:pb-6 @xl:pt-6`}>
          <div className="col-start-2 row-start-1 flex min-w-0 flex-col gap-1">
            <h2 className="text-[16px] leading-6 font-semibold tracking-[-0.015em] text-balance text-[var(--dash-text)] @min-[19rem]:text-[18px]">
              Before you go live
            </h2>
            <span
              className={`text-[13px] font-medium tabular-nums ${HERO_MUTED}`}
            >
              {requiredDone} of {requiredTotal} done
            </span>
          </div>
          <div
            className={`relative col-start-1 row-start-1 aspect-square ${HERO_SLOT}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label="Required setup progress"
          >
            <ProgressRing pct={pct} />
          </div>
        </div>
      </div>

      <ul className="flex flex-col gap-1 px-2 py-2 @sm:px-3 @sm:py-3">
        {required.map((item, index) => (
          <TaskRow
            key={item.key}
            item={item}
            number={index + 1}
            open={open === item.key}
            onToggle={() => setOpen(open === item.key ? null : item.key)}
            phone={
              item.key === "phone"
                ? {
                    canVerify: ownerCanVerifyPhone,
                    onVerified: () => {
                      toast.success("Mobile number verified");
                      // Move on to the next task while the refreshed list
                      // (with this one ticked) is on its way.
                      setOpen(
                        required.find((i) => !i.done && i.key !== "phone")
                          ?.key ?? null,
                      );
                      router.refresh();
                    },
                  }
                : undefined
            }
          />
        ))}
      </ul>

      {ready && recommended.length > 0 && (
        <div className="border-t border-[var(--dash-border)] bg-[linear-gradient(180deg,#fafafd_0%,#ffffff_100%)] px-2 py-2 @sm:px-3 @sm:py-2.5">
          <button
            type="button"
            onClick={() => setShowRecommended((v) => !v)}
            aria-expanded={showRecommended}
            className={`flex min-h-11 w-full items-center justify-between gap-2.5 rounded-[12px] px-2.5 py-2.5 text-left transition-colors hover:bg-[#f4f4f9] @sm:gap-3 @sm:px-3 ${FOCUS_RING}`}
          >
            <span className="flex min-w-0 items-center gap-2.5 @sm:gap-3">
              {/* In the task icons' column, so it lines up with them. */}
              <span className={`flex shrink-0 justify-center ${ICON_SLOT}`}>
                <span
                  aria-hidden
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-white text-[var(--dash-accent)] ring-1 ring-[rgba(17,24,39,0.08)] shadow-[inset_0_1px_0_#fff,0_1px_2px_rgba(16,24,40,0.06)] @sm:h-8 @sm:w-8 @sm:rounded-[10px]"
                >
                  <ListChecks className="h-4 w-4" />
                </span>
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13.5px] font-semibold text-[var(--dash-text)]">
                  Recommended
                </span>
                <span className="text-[12px] text-[var(--dash-text-2)] tabular-nums">
                  {recommendedDone} of {recommended.length} done · optional,
                  nothing here holds the store back
                </span>
              </span>
            </span>
            <ChevronDown
              className={`${CHEVRON} motion-safe:transition-transform ${
                showRecommended ? "rotate-180" : ""
              }`}
            />
          </button>
          {showRecommended && (
            <ul className="mt-1 flex flex-col gap-1">
              {recommended.map((item, index) => (
                <TaskRow
                  key={item.key}
                  item={item}
                  number={index + 1}
                  open={open === item.key}
                  onToggle={() => setOpen(open === item.key ? null : item.key)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** The ring drawn inside the progress bar. Pure decoration over the bar's own
 *  aria-valuenow, so it is hidden from assistive technology. The gradient's id
 *  is unique per card, since several cards can share a page. */
function ProgressRing({ pct }: { pct: number }) {
  const gradient = `setup-ring-${useId().replace(/[^\w-]/g, "")}`;
  // Everything done: the arc turns the same green as the ticks.
  const complete = pct >= 100;
  // A 5-unit stroke at radius 27 leaves the number a 49-unit clear disc, so
  // even "100%" sits inside the track when the ring is at its smallest (44px).
  const radius = 27;
  const length = 2 * Math.PI * radius;
  return (
    <>
      <svg
        aria-hidden
        viewBox="0 0 64 64"
        className={`h-full w-full -rotate-90 ${
          complete
            ? "drop-shadow-[0_4px_10px_rgba(21,163,74,0.3)]"
            : "drop-shadow-[0_4px_10px_rgba(99,102,241,0.25)]"
        }`}
      >
        <defs>
          {/* After the quarter turn, the SVG's right is the screen's top:
              indigo where the arc starts, violet as it comes round. */}
          <linearGradient
            id={gradient}
            x1="64"
            y1="32"
            x2="0"
            y2="32"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={complete ? "#15a34a" : "#4f46e5"} />
            <stop offset="1" stopColor={complete ? "#22c55e" : "#8b5cf6"} />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="23.5" fill="#ffffff" fillOpacity="0.92" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="5"
          stroke="rgba(79, 70, 229, 0.2)"
        />
        {pct > 0 && (
          <circle
            cx="32"
            cy="32"
            r={radius}
            fill="none"
            stroke={`url(#${gradient})`}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={length}
            strokeDashoffset={length * (1 - pct / 100)}
            className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-out"
          />
        )}
      </svg>
      <span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center"
      >
        <span className="flex items-baseline text-[11px] font-semibold tracking-[-0.03em] text-[var(--dash-text)] tabular-nums @sm:text-[12.5px]">
          {pct}
          <span className="ml-px text-[8px] font-medium tracking-normal text-[var(--dash-text-2)] @sm:text-[9px]">
            %
          </span>
        </span>
      </span>
    </>
  );
}

/** A filled green disc with a white check: the finished mark for tasks and
 *  their steps (3.3:1 against white, and the check against the disc). */
function Tick({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-[#15a34a] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(21,128,61,0.3)] ${
        small ? "h-[18px] w-[18px]" : "h-5 w-5"
      }`}
    >
      <Check
        className={small ? "h-[11px] w-[11px]" : "h-3 w-3"}
        strokeWidth={3.25}
      />
    </span>
  );
}

function TaskRow({
  item,
  number,
  open,
  onToggle,
  phone,
}: {
  item: LaunchChecklistItem;
  /** The task's place in its list, shown in its ring until it is done. */
  number: number;
  open: boolean;
  onToggle: () => void;
  /** Present only for the mobile task, which is done inline, not elsewhere. */
  phone?: { canVerify: boolean; onVerified: () => void };
}) {
  const steps = item.steps ?? [];
  const stepsDone = steps.filter((s) => s.done).length;
  // A plain task's one button sits beside its title and description when the
  // card is wide; the mobile form and a task's steps need the full width, so
  // they go below.
  const buttonBeside = !(phone && !item.done) && steps.length === 0;
  const OpenIcon = open && !item.done ? (TASK_ICONS[item.key] ?? Circle) : null;
  return (
    <li className={`relative rounded-[12px] ${open ? OPEN_ROW : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`group flex min-h-11 w-full gap-2.5 rounded-[12px] px-2.5 text-left transition-colors @sm:gap-3 @sm:px-3 @xl:col-start-1 @xl:row-start-1 ${FOCUS_RING} ${
          open
            ? "items-start pt-3 pb-2 @sm:pt-3.5"
            : "items-start py-3 hover:bg-[#f6f6fa]"
        }`}
      >
        <span
          aria-hidden
          className={`flex shrink-0 justify-center ${ICON_SLOT}`}
        >
          {item.done ? (
            <Tick />
          ) : OpenIcon ? (
            <span className={OPEN_TILE}>
              <OpenIcon
                className="h-[15px] w-[15px] @sm:h-4 @sm:w-4"
                strokeWidth={2}
              />
            </span>
          ) : (
            <span
              className={`flex h-5 w-5 items-center justify-center bg-white text-[10.5px] leading-none font-semibold text-[var(--dash-text-2)] tabular-nums ${HOLLOW_RING}`}
            >
              {number}
            </span>
          )}
        </span>
        {/* The title, and a grouped task's count: under it while the card is
            compact, at the row's end once there is room. Beside the taller
            icon tile it drops so its first line sits on the tile's centre. */}
        <span
          className={`flex min-w-0 flex-1 flex-col items-start gap-1 @sm:flex-row @sm:justify-between @sm:gap-3 ${
            OpenIcon ? "pt-1 @sm:pt-1.5" : ""
          }`}
        >
          <span
            className={`leading-5 ${
              item.done
                ? `text-[13.5px] ${DONE_TITLE}`
                : open
                  ? "text-[14px] font-semibold text-[var(--dash-text)]"
                  : "text-[13.5px] font-medium text-[var(--dash-text)]"
            }`}
          >
            {item.title}
          </span>
          {steps.length > 0 && !item.done && (
            <span
              className={`shrink-0 leading-5 tabular-nums ${
                open ? COUNT_OPEN : COUNT_FOLDED
              }`}
            >
              {stepsDone} of {steps.length}
            </span>
          )}
        </span>
        {!open && (
          <ChevronRight
            className={`mt-0.5 ${CHEVRON} motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5`}
          />
        )}
      </button>
      {open && (
        <>
          <p
            className={`pr-3 pb-3 text-[13px] leading-relaxed text-[var(--dash-text-2)] @sm:pr-4 @sm:pb-3.5 @xl:col-start-1 @xl:row-start-2 ${TITLE_INDENT} ${REVEAL}`}
          >
            {item.description}
          </p>
          {buttonBeside ? (
            <div
              className={`pr-3 pb-4 @xl:col-start-2 @xl:row-span-2 @xl:row-start-1 @xl:self-center @xl:pr-4 @xl:pb-0 @xl:pl-2 ${TITLE_INDENT} ${REVEAL}`}
            >
              <TaskLink
                href={item.href}
                done={item.done}
                action={item.action}
              />
            </div>
          ) : (
            <div className={`${PANEL_PLACE} ${REVEAL}`}>
              {phone && !item.done ? (
                phone.canVerify ? (
                  <div className={`${INNER_PANEL} p-3.5 @sm:p-4`}>
                    <VerifyPhoneForm onVerified={phone.onVerified} />
                  </div>
                ) : (
                  // Anyone else verifying THEIR number would not finish the
                  // owner's task, so there is nothing to press here.
                  <p
                    className={`${INNER_PANEL} px-3.5 py-3 text-[12.5px] text-[var(--dash-text-2)]`}
                  >
                    The store owner verifies their own mobile number.
                  </p>
                )
              ) : (
                <StepList item={item} steps={steps} />
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** The button under a task or a step: its action until it is done, then a
 *  quieter Review, the same rule for both. It never runs wider than its
 *  column: in a very narrow card a long label wraps rather than spills. */
function TaskLink({
  href,
  done,
  action,
  label,
  className = "",
}: {
  href: string;
  done: boolean;
  action: string;
  /** What a Review button reviews, when several sit side by side. */
  label?: string;
  /** Where the button sits in its row (layout only). */
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={done && label ? `Review ${label}` : undefined}
      className={`group dash-btn dash-btn-sm max-w-full whitespace-normal! ${
        done ? "dash-btn-ghost" : `dash-btn-primary ${PRIMARY_GLOSS}`
      } ${FOCUS_RING} ${className}`}
    >
      {done ? "Review" : action}
      {!done && (
        <ArrowRight className="h-3.5 w-3.5 motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" />
      )}
    </Link>
  );
}

function StepList({
  item,
  steps,
}: {
  item: LaunchChecklistItem;
  steps: NonNullable<LaunchChecklistItem["steps"]>;
}) {
  // ★ One page, one button: four "Write policy" buttons to the same editor
  // would read as four separate chores.
  const shared = steps.every((s) => s.href === steps[0].href);
  return (
    <div className="flex flex-col gap-3">
      <ul
        className={`flex flex-col divide-y divide-[rgba(17,24,39,0.06)] ${INNER_PANEL}`}
        aria-label={`${item.title}: steps`}
      >
        {steps.map((step, index) => (
          <li key={step.key} className={STEP_ROW}>
            <span
              aria-hidden
              className="flex h-5 w-5 items-center justify-center"
            >
              {step.done ? (
                <Tick small />
              ) : (
                // The step's place in the list, a quiet numeral in its ring.
                <span
                  className={`flex h-[18px] w-[18px] items-center justify-center text-[10px] leading-none font-semibold text-[var(--dash-text-2)] tabular-nums ${HOLLOW_RING}`}
                >
                  {index + 1}
                </span>
              )}
            </span>
            <span className="min-w-0 text-[13px] leading-5">
              <span className="sr-only">
                {step.done ? "Done: " : "To do: "}
              </span>
              <span
                className={
                  step.done ? DONE_TITLE : "font-medium text-[var(--dash-text)]"
                }
              >
                {step.title}
              </span>
            </span>
            {!shared && (
              <TaskLink
                href={step.href}
                done={step.done}
                action={step.action}
                label={step.title}
                className={STEP_BUTTON}
              />
            )}
          </li>
        ))}
      </ul>
      {shared && (
        <div>
          <TaskLink href={item.href} done={item.done} action={item.action} />
        </div>
      )}
    </div>
  );
}

function GoLiveHead({
  ready,
  missing,
  canLaunch,
  password,
  previewUrl,
}: {
  ready: boolean;
  missing: string[];
  canLaunch: boolean;
  password: string | null;
  previewUrl: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rotating, startRotate] = useTransition();
  const [shown, setShown] = useState(password);

  function copy() {
    if (!shown) return;
    navigator.clipboard
      ?.writeText(shown)
      .then(() => toast.success("Password copied"))
      .catch(() => toast.error("Couldn't copy - select it and copy by hand."));
  }

  function goLive() {
    start(async () => {
      const res = await launchStore();
      if (res.error) {
        toast.error(
          res.missing?.length
            ? `${res.error} Still to do: ${res.missing.join(", ")}.`
            : res.error,
        );
        return;
      }
      toast.success("Your store is open to customers.");
      router.refresh();
    });
  }

  function rotate() {
    startRotate(async () => {
      const res = await regenerateStorefrontPassword();
      if (res.error || !res.password) {
        toast.error(res.error ?? "Couldn't change the password.");
        return;
      }
      setShown(res.password);
      toast.success(
        "New password set. Anyone using the old one is signed out.",
      );
    });
  }

  return (
    <div
      className={`${HERO_ROW} gap-y-1.5 pt-3.5 @sm:pt-5 @xl:grid-cols-[auto_minmax(0,1fr)_auto] @xl:pt-6`}
    >
      {/* The lock sits in the column the progress ring uses below, so the
          two share one axis. It spans the title and the password once the
          password has room to sit indented under the title. */}
      <span
        className={`col-start-1 row-start-1 flex justify-center @min-[19rem]:row-span-2 ${HERO_SLOT}`}
      >
        <span className={LOCK_TILE}>
          <Lock className="h-4 w-4 @sm:h-[18px] @sm:w-[18px]" />
        </span>
      </span>
      <div className="col-start-2 row-start-1 text-[14px] leading-5 font-semibold tracking-[-0.005em] text-[var(--dash-text)]">
        Your store is password protected
      </div>
      <div
        className={`col-span-2 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] @min-[19rem]:col-span-1 @min-[19rem]:col-start-2 ${HERO_MUTED}`}
      >
        <span className="flex items-center gap-2">
          <span>Password</span>
          <code className={PASSWORD_CHIP}>{shown ?? "unavailable"}</code>
        </span>
        {/* Copy, New and Preview stay together, dropping under the password
            as one line when it is short of room. */}
        <span className="-ml-1 flex items-center gap-0.5 @sm:-ml-1.5 @sm:gap-1">
          <button
            type="button"
            onClick={copy}
            disabled={!shown}
            className={HERO_ACTION}
            aria-label="Copy store password"
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
          {canLaunch && (
            <button
              type="button"
              onClick={rotate}
              disabled={rotating}
              className={HERO_ACTION}
            >
              {rotating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              New
            </button>
          )}
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={HERO_ACTION}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Preview
          </a>
        </span>
      </div>
      <button
        type="button"
        onClick={goLive}
        disabled={!canLaunch || !ready || pending}
        title={
          !canLaunch
            ? "Only the store owner can open the store."
            : ready
              ? "Open the store to customers"
              : `Still to do: ${missing.join(", ")}`
        }
        className={`dash-btn dash-btn-primary relative isolate overflow-hidden ${GO_LIVE_PLACE} ${styles.goLive} ${GO_LIVE} ${FOCUS_RING}`}
      >
        <span aria-hidden className={styles.sheen} />
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Rocket className="h-4 w-4" />
        )}
        Go live
      </button>
    </div>
  );
}
