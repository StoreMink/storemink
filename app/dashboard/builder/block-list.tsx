"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";

// ---------------------------------------------------------------------------
// The block list under a section (Shopify's block model in the inspector).
// One ordered, capped list of repeatable children — slides, tiles, items,
// stories, rows — with add / remove / move and a collapsible body per block,
// so a section holding twelve rows stays scannable. Pure and controlled: the
// caller owns the array and renders each block's own fields.
//
// Blocks start COLLAPSED showing only their title line; a block the merchant
// just added opens, since it has nothing to show a title for yet. Open state
// follows a block when it moves and is dropped when it is removed.
// ---------------------------------------------------------------------------

export function BlockList<T>({
  label,
  itemLabel,
  items,
  max,
  newItem,
  onChange,
  title,
  children,
}: {
  /** Heading over the list ("Tiles", "Stories", "Rows"). */
  label: string;
  /** Singular noun for the add button and the fallback title ("Tile"). */
  itemLabel: string;
  items: T[];
  max: number;
  newItem: () => T;
  onChange: (items: T[]) => void;
  /** The collapsed title line; falls back to "<itemLabel> N". */
  title?: (item: T, index: number) => string;
  /** The block's own fields, given a patch setter for that block. */
  children: (
    item: T,
    index: number,
    setItem: (patch: Partial<T>) => void,
  ) => React.ReactNode;
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());

  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const setItem = (index: number, patch: Partial<T>) =>
    onChange(
      items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    setOpen((current) => {
      const swapped = new Set<number>();
      for (const i of current) {
        if (i === index) swapped.add(target);
        else if (i === target) swapped.add(index);
        else swapped.add(i);
      }
      return swapped;
    });
  };

  const remove = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
    setOpen((current) => {
      const shifted = new Set<number>();
      for (const i of current) {
        if (i < index) shifted.add(i);
        else if (i > index) shifted.add(i - 1);
      }
      return shifted;
    });
  };

  const add = () => {
    if (items.length >= max) return;
    onChange([...items, newItem()]);
    setOpen((current) => new Set([...current, items.length]));
  };

  return (
    <div className="space-y-2" data-block-list={label}>
      <label className="text-muted-foreground mb-1.5 block text-xs font-medium uppercase tracking-wide">
        {label}
        <span className="ml-1 font-normal normal-case tracking-normal">
          ({items.length}/{max})
        </span>
      </label>
      {items.map((item, index) => {
        const isOpen = open.has(index);
        const heading = title?.(item, index)?.trim();
        return (
          <div
            key={index}
            className="bg-background rounded-md border"
            data-block-open={isOpen ? "true" : "false"}
          >
            <div className="flex items-center gap-1 p-2">
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-expanded={isOpen}
                className="text-foreground hover:bg-muted flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left text-xs font-medium"
              >
                {isOpen ? (
                  <ChevronUp className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate">
                  {heading || `${itemLabel} ${index + 1}`}
                </span>
              </button>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === items.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {isOpen && (
              <div className="space-y-2 border-t p-2">
                {children(item, index, (patch) => setItem(index, patch))}
              </div>
            )}
          </div>
        );
      })}
      {items.length < max && (
        <button
          type="button"
          onClick={add}
          className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
        >
          <Plus className="h-3.5 w-3.5" /> Add {itemLabel.toLowerCase()}
        </button>
      )}
    </div>
  );
}
