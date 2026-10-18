"use client";

import { useRef, type KeyboardEvent } from "react";

/**
 * A choice between equally valid options, every option visible and the
 * chosen one filled.
 *
 * ★ NOT AN ON/OFF SWITCH. Picking Google Chirp 3 or Sarvam Saaras v4 (or the
 * browser voice or a model) has no "off" side, and a grey switch thumb sitting
 * on the left read as "this is switched off" to an operator new to the page
 * (owner, 2026-10-18). A segmented control names both sides and highlights
 * whichever is in use, so the screen always says what is running.
 *
 * A radio group: arrow keys move the choice, and only the chosen option is in
 * the tab order. `dormant` is for a choice that is saved but not in use (the
 * model while the browser voice reads): it stays visible, in grey rather than
 * violet, so it never looks like something running.
 */
export function SegmentedChoice<T extends string>({
  label,
  value,
  options,
  disabled = false,
  dormant = false,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  dormant?: boolean;
  onChange: (next: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next].value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={`inline-flex shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-0.5 ${
        disabled ? "opacity-60" : ""
      }`}
    >
      {options.map((option, index) => {
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!chosen) onChange(option.value);
            }}
            onKeyDown={(event) => move(event, index)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed ${
              chosen
                ? dormant
                  ? "bg-white text-slate-700 shadow-sm"
                  : "bg-violet-600 text-white shadow-sm"
                : "text-slate-600 enabled:hover:bg-white enabled:hover:text-slate-900"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
