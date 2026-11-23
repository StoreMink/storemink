import type { DesignPlan } from "@/lib/theme-studio/design-plan";
import type { DistinctnessReport } from "@/lib/theme-studio/fingerprint";
import { FONT_PAIRINGS } from "@/lib/themes/fonts";
import { plainText } from "../studio-ui";

// The design plan of a version (lib/theme-studio/design-plan.ts): what was
// decided before anything was built, and what it was checked against before
// any picture was drawn. Read-only: an operator changes a design by asking
// for a change, never by editing its plan.

const COLOURS: [key: keyof DesignPlan["colours"], label: string][] = [
  ["page", "Page"],
  ["surface", "Cards"],
  ["ink", "Text"],
  ["accent", "Accent"],
];

function layoutWords(layout: NonNullable<DesignPlan["layout"]>): string {
  return [
    `${layout.header} header`,
    `${layout.card.replace("_", " ")} product card`,
    `${layout.productDetail} product page`,
    `${layout.footer} footer`,
    `${layout.pageWidth} page width`,
    `${layout.gridColumnsDesktop} columns`,
    layout.cardHoverImage ? "second photo on hover" : "no hover photo",
  ].join(", ");
}

export function DesignPlanCard({
  plan,
  distinctness,
}: {
  plan: DesignPlan;
  distinctness: DistinctnessReport | null | undefined;
}) {
  const floor = distinctness?.publishFloor;
  return (
    <section className="studio-plan" aria-labelledby="studio-plan-title">
      <h3 id="studio-plan-title" className="text-sm font-semibold">
        Design plan
      </h3>
      <p className="studio-muted text-sm">
        Decided before anything was built, and checked against every published
        theme.
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="studio-muted">Colours</dt>
        <dd className="flex flex-wrap gap-3">
          {COLOURS.map(([key, label]) => (
            <span key={key} className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-5 w-5 rounded border border-black/15"
                style={{ background: plan.colours[key] }}
              />
              {label} {plan.colours[key]}
            </span>
          ))}
        </dd>
        <dt className="studio-muted">Fonts</dt>
        <dd>{FONT_PAIRINGS[plan.fontPairing].label}</dd>
        <dt className="studio-muted">Buttons</dt>
        <dd>
          {plan.buttons.shape}, {plan.buttons.primary}
        </dd>
        {plan.layout ? (
          <>
            <dt className="studio-muted">Layout</dt>
            <dd>
              {layoutWords(plan.layout)}.{" "}
              <span className="studio-muted">
                {plan.layoutSource === "reference"
                  ? "Read from the reference screenshots."
                  : "The layout the catalogue uses least for this direction."}
              </span>
            </dd>
          </>
        ) : null}
        <dt className="studio-muted">Styling</dt>
        <dd>
          <ul className="list-disc pl-5">
            {plan.styling.map((line) => (
              <li key={line}>{plainText(line)}</li>
            ))}
          </ul>
        </dd>
        <dt className="studio-muted">Sets it apart</dt>
        <dd>
          <ul className="list-disc pl-5">
            {plan.setsApart.map((line) => (
              <li key={line}>{plainText(line)}</li>
            ))}
          </ul>
        </dd>
        {floor ? (
          <>
            <dt className="studio-muted">Checked</dt>
            <dd>
              Before any picture was drawn, the built design was measured
              against the published themes. The nearest is &quot;
              {plainText(floor.nearestName)}&quot;: this design is{" "}
              {Math.round(floor.score * 100)}% different, and at least{" "}
              {Math.round(floor.threshold * 100)}% is needed to publish.
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
