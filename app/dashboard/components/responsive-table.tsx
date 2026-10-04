import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";

type CellKind = "field" | "primary" | "selection" | "image" | "actions";
type Column = { label: string; kind: CellKind };
type Element = ReactElement<
  HTMLAttributes<HTMLElement> & {
    children?: ReactNode;
    colSpan?: number;
    rowSpan?: number;
  }
>;

// Resolve conditional columns and fragments before assigning labels. Mapping
// by a fixed column index would mislabel every field for view-only staff.
function flatten(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? flatten(child.props.children)
      : [child],
  );
}

function text(children: ReactNode): string {
  return flatten(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One semantic table: ordinary columns on desktop, labelled records on phones.
 * Original cells, links, inputs, menus and event handlers remain mounted.
 * Multi-level headers retain the normal scrolling table rather than guessing
 * their labels. No DOM observer or viewport-dependent duplicate data is used.
 */
export function ResponsiveTable({
  children,
  className = "",
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  const parts = flatten(children);
  const head = parts.find(
    (part) => isValidElement(part) && part.type === "thead",
  ) as Element | undefined;
  const headRows = flatten(head?.props.children).filter(
    (part): part is Element => isValidElement(part) && part.type === "tr",
  );
  const headers = flatten(headRows[0]?.props.children).filter(
    (part): part is Element => isValidElement(part) && part.type === "th",
  );
  const supported =
    headRows.length === 1 &&
    headers.length > 0 &&
    headers.every(
      (cell) =>
        (cell.props.colSpan ?? 1) === 1 && (cell.props.rowSpan ?? 1) === 1,
    );
  if (!supported)
    return (
      <table className={className} {...props}>
        {children}
      </table>
    );

  const columns: Column[] = headers.map((header) => {
    const label = text(header.props.children);
    const cls = header.props.className ?? "";
    const kind = cls.includes("dash-checkbox-cell")
      ? "selection"
      : cls.includes("dash-col-actions") || /^(actions?|manage)$/i.test(label)
        ? "actions"
        : /^image$/i.test(label)
          ? "image"
          : "field";
    return {
      label: label || (kind === "selection" ? "Select" : "Details"),
      kind,
    };
  });
  const primary = columns.findIndex((column) => column.kind === "field");
  if (primary >= 0) columns[primary].kind = "primary";

  function row(child: ReactNode, header = false): ReactNode {
    if (!isValidElement(child) || child.type !== "tr") return child;
    const element = child as Element;
    let index = 0;
    const cells = flatten(element.props.children).map((cell) => {
      if (!isValidElement(cell) || (cell.type !== "td" && cell.type !== "th"))
        return cell;
      const original = cell as ReactElement<
        TdHTMLAttributes<HTMLTableCellElement> &
          ThHTMLAttributes<HTMLTableCellElement>
      >;
      const column = columns[index];
      index += original.props.colSpan ?? 1;
      const full = (original.props.colSpan ?? 1) > 1;
      const kind = full ? "full" : (column?.kind ?? "field");
      const label = full ? "" : (column?.label ?? "Details");
      return cloneElement(original, {
        role: header
          ? "columnheader"
          : original.type === "th"
            ? "rowheader"
            : "cell",
        ...(header ? { scope: "col" } : {}),
        "data-mobile-kind": kind,
        children: header ? (
          <>
            {original.props.children}
            {kind === "selection" && (
              <span className="dash-mobile-cell-label" aria-hidden="true">
                Select all on this page
              </span>
            )}
          </>
        ) : (
          <>
            {label &&
              kind !== "selection" &&
              kind !== "image" &&
              kind !== "actions" && (
                <span
                  className="dash-mobile-cell-label"
                  data-label={label}
                  aria-hidden="true"
                />
              )}
            <div className="dash-mobile-cell-value">
              {original.props.children}
            </div>
          </>
        ),
      } as Partial<typeof original.props>);
    });
    return cloneElement(element, {
      role: "row",
      "data-mobile-image":
        (!header && columns.some((column) => column.kind === "image")) ||
        undefined,
      "data-mobile-selection":
        (!header && columns.some((column) => column.kind === "selection")) ||
        undefined,
      children: cells,
    } as Partial<typeof element.props>);
  }

  return (
    <table
      {...props}
      role="table"
      className={`${className} dash-table-responsive`}
    >
      {parts.map((part) => {
        if (
          !isValidElement(part) ||
          !["thead", "tbody", "tfoot"].includes(String(part.type))
        )
          return part;
        const element = part as Element;
        return cloneElement(element, {
          role: "rowgroup",
          children: flatten(element.props.children).map((child) =>
            row(child, element.type === "thead"),
          ),
        });
      })}
    </table>
  );
}
