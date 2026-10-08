import type { GateResult } from "./acceptance-gates";
import type { Scores } from "./scorecard";

export interface QaRepair {
  kind: "settings" | "image" | "renderer";
  target: string | null;
  reason: string;
}
export interface QaProgress {
  patterns: string[];
  severity: number;
  visualDeficit: number | null;
  rejections: string[];
  repairTargets?: string[];
  contrastDeficits?: Record<string, number>;
  patternSeverity?: Record<string, number>;
}

/** Ignore wording, measurements and ordering when identifying a repeated fault.
 * Preserve viewport, element selectors and finding codes. */
export function qaProgress(
  gates: readonly GateResult[],
  visual?: {
    scores: Scores;
    rejections: readonly string[];
    repairs?: readonly QaRepair[];
  } | null,
): QaProgress {
  const patterns: string[] = [];
  let severity = 0;
  const contrastDeficits: Record<string, number> = {};
  const patternSeverity: Record<string, number> = {};
  for (const g of gates.filter((g) => g.required && g.status !== "pass")) {
    if (!g.findings.length) patterns.push(`${g.id}:incomplete`);
    for (const f of g.findings) {
      // Browser messages carry a selector in parentheses or axe examples.
      const selector =
        f.message.split(/ — (?:examples|first): /)[1]?.replace(/: .*$/, "") ??
        (g.id !== "browser.accessibility"
          ? f.message.match(/\(([^)]+)\)/)?.[1]
          : "") ??
        "";
      const pattern = `${g.id}:${f.code}:${f.where ?? ""}:${selector}`;
      patterns.push(pattern);
      if (f.code === "color-contrast") {
        for (const measurement of f.contrast ?? []) {
          const key = `${f.where ?? ""}:${measurement.target}`;
          contrastDeficits[key] = Math.max(
            0,
            measurement.required - measurement.ratio,
          );
        }
      }
      const numbers = f.message.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      const findingSeverity =
        f.code === "extreme_crop"
          ? Math.max(0, 35 - (numbers[0] ?? 0))
          : f.code === "small_target"
            ? Math.max(0, 24 - (numbers[0] ?? 0)) +
              Math.max(0, 24 - (numbers[1] ?? 0))
            : f.code === "clipped_text"
              ? Math.max(1, (numbers[0] ?? 0) + (numbers[1] ?? 0))
              : f.code === "horizontal_overflow"
                ? Math.max(1, numbers[0] ?? 1)
                : f.code === "color-contrast"
                  ? Number(f.message.match(/\((\d+) elements?/)?.[1] ?? 1)
                  : 1;
      severity += findingSeverity;
      patternSeverity[pattern] =
        (patternSeverity[pattern] ?? 0) + findingSeverity;
    }
  }
  return {
    patterns: patterns.sort(),
    severity,
    ...(Object.keys(contrastDeficits).length
      ? { contrastDeficits, patternSeverity }
      : {}),
    visualDeficit: visual
      ? Math.max(
          0,
          34 - Object.values(visual.scores).reduce((a, b) => a + b, 0),
        ) +
        Object.values(visual.scores).reduce((n, s) => n + Math.max(0, 4 - s), 0)
      : null,
    rejections: [...(visual?.rejections ?? [])].sort(),
    repairTargets: [
      ...new Set(
        (visual?.repairs ?? []).map(
          (r) => `${r.kind}:${r.target ?? "platform"}`,
        ),
      ),
    ].sort(),
  };
}

export function qaImproved(current: QaProgress, previous: QaProgress): boolean {
  const prior = new Set(previous.patterns);
  const noNew = current.patterns.every((p) => prior.has(p));
  if (current.patterns.length || previous.patterns.length) {
    const before = previous.contrastDeficits ?? {};
    const after = current.contrastDeficits ?? {};
    const keys = Object.keys(before);
    const ratioProgress =
      keys.length > 0 &&
      Object.keys(after).length === keys.length &&
      keys.every(
        (key) => typeof after[key] === "number" && after[key] <= before[key],
      ) &&
      Object.entries(current.patternSeverity ?? {}).every(
        ([key, value]) => value <= (previous.patternSeverity?.[key] ?? -1),
      ) &&
      keys.reduce((sum, key) => sum + after[key], 0) <
        keys.reduce((sum, key) => sum + before[key], 0) * 0.9;
    return (
      noNew &&
      (current.patterns.length < previous.patterns.length ||
        (current.patterns.length === previous.patterns.length &&
          (current.severity < previous.severity * 0.9 ||
            (current.severity <= previous.severity && ratioProgress))))
    );
  }
  if (current.visualDeficit === null || previous.visualDeficit === null)
    return true;
  const currentTargets = current.repairTargets ?? [];
  const previousTargets = previous.repairTargets ?? [];
  return (
    currentTargets.every((r) => previousTargets.includes(r)) &&
    current.rejections.every((r) => previous.rejections.includes(r)) &&
    (currentTargets.length < previousTargets.length ||
      current.rejections.length < previous.rejections.length ||
      current.visualDeficit < previous.visualDeficit)
  );
}

/** Classify deterministic failures by the authority the theme package has.
 * An image redraw cannot change a frame or a button's hit area. */
export function deterministicRepairs(gates: readonly GateResult[]): QaRepair[] {
  return gates
    .filter((g) => g.required && g.status !== "pass")
    .flatMap((g) => {
      const findings = g.findings.length
        ? g.findings
        : [{ code: "incomplete", message: "Required evidence is incomplete." }];
      return findings.map((f) => ({
        // A slow paint or a layout shift is the platform's to fix (image
        // sizing, preload, reserved space); a settings edit cannot be
        // trusted to move it, and a paid revision is not the answer.
        kind: (g.id === "browser.tap_targets" ||
        g.id === "routes.markup" ||
        g.id === "browser.performance" ||
        (g.id === "browser.accessibility" &&
          !["color-contrast", "contrast"].includes(f.code))
          ? "renderer"
          : "settings") as QaRepair["kind"],
        target: null,
        reason: `${g.label}: ${f.message}`.slice(0, 800),
      }));
    });
}

export function parseQaRepairs(raw: unknown): QaRepair[] | null {
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const repairs: QaRepair[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).some((k) => !["kind", "target", "reason"].includes(k)) ||
      !["settings", "image", "renderer"].includes(String(v.kind)) ||
      (v.target !== null &&
        (typeof v.target !== "string" || v.target.length > 300)) ||
      typeof v.reason !== "string" ||
      !v.reason.trim() ||
      v.reason.length > 800
    )
      return null;
    repairs.push(v as unknown as QaRepair);
  }
  return repairs;
}
