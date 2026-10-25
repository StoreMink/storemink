import {
  CheckCircle2,
  Circle,
  CircleDot,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  ThemeStudioBuildTimeRange,
  ThemeStudioProgress,
  ThemeStudioProgressStep,
} from "@/lib/theme-studio/progress";
import type { StudioStatus } from "../studio-status";
import { plainText } from "../studio-ui";
import { buildTimeWords, clockWords, durationWords } from "../studio-words";

// ---------------------------------------------------------------------------
// The progress card (wave TS-2, plan section 4 "Theme page, building"). It
// sits at the end of the chat and names each step with its time, from the
// progress read (lib/theme-studio/progress.ts, polled by
// use-studio-progress.ts). No hooks: the workspace renders it with the
// newest poll.
//
// ★ NAMED ROWS, NEVER "STEP 4 OF 7". A repair goes back through the layout
// check, so a number would run backwards; a repair round is its own row
// ("Fixing what the review found (round 2 of 3)"). A "next try at 10:31"
// appears only when the step really waits for a set time.
//
// ★ THE PLAN LINE: the AI's assumptions and the capabilities it left out
// that do not block (plan section 4, "Controls that keep a home"). Blocking
// gaps are serious findings and belong to the Checks tab.
// ---------------------------------------------------------------------------

const STATE_WORDS: Record<ThemeStudioProgressStep["state"], string> = {
  done: "Done",
  running: "Working on it now",
  waiting: "Not started yet",
  failed: "Stopped",
  skipped: "Skipped",
};

const STATE_ICON: Record<ThemeStudioProgressStep["state"], LucideIcon> = {
  done: CheckCircle2,
  running: CircleDot,
  waiting: Circle,
  failed: XCircle,
  skipped: MinusCircle,
};

/** What the AI assumed and left out of the design it made. */
export interface StudioPlan {
  assumptions: string[];
  /** Capabilities the design asked for that StoreMink cannot render, which
   * do not block (blocking ones are serious findings in Checks). */
  leftOut: string[];
}

function stepTime(step: ThemeStudioProgressStep): string | null {
  if (
    (step.state === "done" || step.state === "failed") &&
    step.startedAt &&
    step.finishedAt
  ) {
    const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
    return Number.isFinite(ms) && ms >= 0 ? durationWords(ms) : null;
  }
  return null;
}

function heading(progress: ThemeStudioProgress, status: StudioStatus): string {
  if (status.row === 6) return status.words;
  switch (progress.status.working?.kind) {
    case "waiting":
      return "Waiting to start";
    case "building":
      return "Theme Studio is building";
    case "rechecking":
      return "Checking again on today's StoreMink build";
    case "checking_pictures":
      return "Checking pictures";
    case "checking_change":
      return "Checking your change";
    default:
      return "What Theme Studio did last";
  }
}

function footer(
  progress: ThemeStudioProgress,
  buildTime: ThemeStudioBuildTimeRange,
  notifiesViewer: boolean,
): string | null {
  const kind = progress.status.working?.kind;
  if (!kind) return null;
  const tell = notifiesViewer ? " We'll let you know when it's ready." : "";
  if (kind === "building" || kind === "waiting")
    return `${buildTimeWords(buildTime)} You can leave this page.${tell}`;
  return `About 3 to 5 minutes. You can leave this page.${tell}`;
}

function Steps({
  steps,
  now,
}: {
  steps: readonly ThemeStudioProgressStep[];
  now: string;
}) {
  return (
    <ol className="studio-steps">
      {steps.map((step) => {
        const Icon = STATE_ICON[step.state];
        const time = stepTime(step);
        const detail = step.detail ? plainText(step.detail) : null;
        return (
          <li key={step.key} className="studio-step" data-state={step.state}>
            <Icon
              aria-hidden="true"
              className={
                step.state === "running"
                  ? "studio-step-icon studio-spin"
                  : "studio-step-icon"
              }
            />
            <span className="studio-step-label">
              <span className="sr-only">{STATE_WORDS[step.state]}: </span>
              {plainText(step.label)}
            </span>
            <span className="studio-step-time">{time ?? ""}</span>
            {detail || step.nextTryAt ? (
              <span className="studio-step-detail">
                {detail}
                {/* "8 of 18. Google is accepting pictures slowly. Next try
                    at 10:33.": a detail without its own full stop gets one. */}
                {detail && step.nextTryAt
                  ? /[.!?]$/.test(detail)
                    ? " "
                    : ". "
                  : null}
                {step.nextTryAt
                  ? `Next try at ${clockWords(step.nextTryAt, now)}.`
                  : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function PlanLine({ plan }: { plan: StudioPlan }) {
  const items = [
    ...plan.assumptions.map((text) => plainText(text)),
    ...plan.leftOut.map(
      (text) => `Left out, StoreMink can't show it yet: ${plainText(text)}`,
    ),
  ];
  if (items.length === 0) return null;
  return (
    <details className="studio-plan">
      <summary>
        Plan: {plan.assumptions.length} assumption
        {plan.assumptions.length === 1 ? "" : "s"}
        {plan.leftOut.length
          ? `, ${plan.leftOut.length} thing${plan.leftOut.length === 1 ? "" : "s"} left out`
          : ""}
      </summary>
      <ul>
        {items.map((text, index) => (
          <li key={`${index}-${text}`}>{text}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The card: open while work runs, is stuck or stopped; folded into a
 * "What Theme Studio did last" summary once the work finished well. Null
 * when nothing was ever started and nothing is working.
 */
export function ProgressCard({
  progress,
  status,
  buildTime,
  plan,
  notifiesViewer,
}: {
  progress: ThemeStudioProgress;
  status: StudioStatus;
  buildTime: ThemeStudioBuildTimeRange;
  plan: StudioPlan | null;
  /** The viewer started this theme, so Theme Studio's notices reach them. */
  notifiesViewer: boolean;
}) {
  const { steps } = progress;
  const working = progress.status.working !== null;
  if (steps.length === 0 && !working) {
    return plan ? (
      <div className="studio-progress">
        <PlanLine plan={plan} />
      </div>
    ) : null;
  }
  const title = heading(progress, status);
  const foot = footer(progress, buildTime, notifiesViewer);
  const stopped = steps.some((step) => step.state === "failed");
  const body = (
    <>
      {steps.length ? (
        <Steps steps={steps} now={progress.status.now} />
      ) : (
        <p className="studio-progress-foot">{status.words}</p>
      )}
      {foot ? <p className="studio-progress-foot">{foot}</p> : null}
      {plan ? <PlanLine plan={plan} /> : null}
    </>
  );
  if (working || stopped || status.row === 6) {
    // One short live line for a screen reader (the step working now), not
    // the whole card, which changes with every poll.
    const running = steps.find((step) => step.state === "running");
    return (
      <section className="studio-progress" aria-label={title}>
        <h3>{title}</h3>
        <p className="sr-only" role="status">
          {running ? `Working on: ${plainText(running.label)}` : ""}
        </p>
        {body}
      </section>
    );
  }
  return (
    <details className="studio-progress">
      <summary>{title}</summary>
      {body}
    </details>
  );
}
