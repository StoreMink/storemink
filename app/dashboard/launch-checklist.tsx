import Link from "next/link";
import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { getLaunchState } from "@/app/actions/launch-actions";
import { GoLiveControls } from "./go-live-controls";

/**
 * Dashboard Home's first card while a store has not opened: what must be in
 * place before Go live, each item linking to where it is done, and the
 * password that protects the shop in the meantime. Once the store is open it
 * collapses to one line naming the public address.
 *
 * Every tick is computed from the store's own rows on each render
 * (lib/store/launch-checklist.ts); nothing here is a checkbox a merchant can
 * tick, because a ticked box with no refund policy behind it is a lie.
 */
export async function LaunchChecklistCard() {
  const state = await getLaunchState();
  if (!state) return null;

  if (state.launched) {
    return (
      <section className="flex items-center gap-3 rounded-[var(--dash-radius)] border border-[var(--dash-border)] bg-[var(--dash-surface)] px-4 py-3 shadow-[var(--dash-shadow-xs)]">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--dash-green)]" />
        <div className="min-w-0 flex-1 text-[13.5px] text-[var(--dash-text-2)]">
          Your store is open to customers at{" "}
          <a
            href={state.storeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[var(--dash-text)] underline-offset-2 hover:underline"
          >
            {state.storeUrl.replace(/^https?:\/\//, "")}
            <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-2px]" />
          </a>
        </div>
      </section>
    );
  }

  const { checklist } = state;
  const required = checklist.items.filter((i) => i.required);
  const recommended = checklist.items.filter((i) => !i.required);
  const pct = Math.round(
    (checklist.requiredDone / Math.max(checklist.requiredTotal, 1)) * 100,
  );

  return (
    <section className="dash-card flex flex-col gap-4 p-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-[16px] font-bold tracking-tight text-[var(--dash-text)]">
            Open your store
          </h2>
          <span className="text-[12.5px] font-medium text-[var(--dash-text-3)]">
            {checklist.requiredDone} of {checklist.requiredTotal} required steps
            done
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--dash-surface-2)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div
            className="h-full rounded-full bg-[var(--dash-accent)] transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[13px] leading-snug text-[var(--dash-text-3)]">
          Your storefront is private until these are done. Each step ticks
          itself off when the page it links to is saved.
        </p>
      </header>

      <ChecklistGroup title="Required before going live" items={required} />
      <ChecklistGroup title="Recommended" items={recommended} />

      <GoLiveControls
        canLaunch={state.canLaunch}
        ready={checklist.ready}
        missing={checklist.missing}
        password={state.password}
        previewUrl={state.previewUrl}
      />
    </section>
  );
}

function ChecklistGroup({
  title,
  items,
}: {
  title: string;
  items: {
    key: string;
    title: string;
    description: string;
    href: string;
    done: boolean;
  }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--dash-text-3)]">
        {title}
      </h3>
      <ul className="flex flex-col divide-y divide-[var(--dash-border)] rounded-lg border border-[var(--dash-border)]">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="group flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--dash-surface-2)]"
            >
              {item.done ? (
                <CheckCircle2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-[var(--dash-green)]" />
              ) : (
                <Circle className="mt-0.5 h-4.5 w-4.5 shrink-0 text-[var(--dash-text-3)]" />
              )}
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[13.5px] font-semibold ${
                    item.done
                      ? "text-[var(--dash-text-3)] line-through decoration-[var(--dash-border)]"
                      : "text-[var(--dash-text)]"
                  }`}
                >
                  {item.title}
                </div>
                {!item.done && (
                  <div className="mt-0.5 text-[12.5px] leading-snug text-[var(--dash-text-3)]">
                    {item.description}
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
