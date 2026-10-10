import { CheckCircle2, ExternalLink } from "lucide-react";
import { getLaunchState } from "@/app/actions/launch-actions";
import { SetupGuide } from "./setup-guide";

/**
 * Dashboard Home's first card while a store has not opened: the password that
 * keeps the shop private and the Go live button, then the required tasks.
 * Once the store is open it collapses to one line naming the public address.
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
  return (
    <SetupGuide
      items={checklist.items}
      requiredDone={checklist.requiredDone}
      requiredTotal={checklist.requiredTotal}
      ready={checklist.ready}
      missing={checklist.missing}
      canLaunch={state.canLaunch}
      ownerCanVerifyPhone={state.ownerCanVerifyPhone}
      password={state.password}
      previewUrl={state.previewUrl}
    />
  );
}
