"use client";

import type { ReactNode } from "react";
import { openHelpMink, type OpenHelpMinkDetail } from "./mink-launch";

/** A button anywhere on a Help page that opens the Mink AI drawer. */
export function AskMinkButton({
  children,
  className,
  mode = "chat",
  question,
  expand,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  mode?: OpenHelpMinkDetail["mode"];
  question?: string;
  /** Open the full view rather than the side drawer. */
  expand?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onClick={() => openHelpMink({ mode, question, expand })}
    >
      {children}
    </button>
  );
}
