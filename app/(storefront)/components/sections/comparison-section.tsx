import Link from "next/link";
import { Check, Minus, X } from "lucide-react";
import type {
  ComparisonColumn,
  ComparisonConfig,
  ComparisonRow,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

// Comparison table — products, plans or options side by side. The section's
// blocks are its rows, typed "text" (one value per column) or "check" (a tick
// per column). "table" renders rows × columns and scrolls sideways on phones
// with the feature labels pinned; "cards" renders one card per column, which
// stack on phones. Every tick carries a screen-reader word, so a row never
// says anything by colour or shape alone.

function Mark({ value }: { value: string }) {
  if (value === "yes")
    return (
      <span className="home-comparison-mark is-yes">
        <Check size={16} aria-hidden strokeWidth={2.5} />
        <span className="sr-only">Yes</span>
      </span>
    );
  if (value === "no")
    return (
      <span className="home-comparison-mark is-no">
        <X size={16} aria-hidden strokeWidth={2.5} />
        <span className="sr-only">No</span>
      </span>
    );
  return (
    <span className="home-comparison-mark is-na">
      <Minus size={16} aria-hidden strokeWidth={2.5} />
      <span className="sr-only">Not applicable</span>
    </span>
  );
}

function Cell({ row, value }: { row: ComparisonRow; value: string }) {
  if (row.type === "check") return <Mark value={value} />;
  return value ? <>{value}</> : <Mark value="" />;
}

function Cta({ column }: { column: ComparisonColumn }) {
  if (!column.cta_label || !column.cta_href) return null;
  const className = `home-comparison-cta ${column.highlight ? "sm-btn-primary" : "sm-btn-secondary"}`;
  if (/^https?:\/\//i.test(column.cta_href)) {
    return (
      <a
        className={className}
        href={column.cta_href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {column.cta_label}
      </a>
    );
  }
  return (
    <Link className={className} href={column.cta_href}>
      {column.cta_label}
    </Link>
  );
}

export function ComparisonSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: ComparisonConfig;
}) {
  const { columns, rows } = config;
  if (columns.length === 0 || rows.length === 0) return null;
  const hasCta = columns.some((c) => c.cta_label && c.cta_href);
  const colClass = (column: ComparisonColumn) =>
    column.highlight ? " is-highlight" : "";

  return (
    <SectionShell sectionId={sectionId} style={style}>
      {(config.heading || config.subheading) && (
        <div className="home-section-head">
          {config.heading && (
            <h2 className="home-section-title">{config.heading}</h2>
          )}
          {config.subheading && (
            <p className="home-section-sub">{config.subheading}</p>
          )}
        </div>
      )}

      {config.style === "cards" ? (
        <div className={`home-comparison-cards cols-${columns.length}`}>
          {columns.map((column, j) => (
            <div
              className={`home-comparison-card${colClass(column)}`}
              key={`${column.label}-${j}`}
            >
              <h3 className="home-comparison-card-title">{column.label}</h3>
              {column.caption && (
                <p className="home-comparison-card-caption">{column.caption}</p>
              )}
              <ul className="home-comparison-card-rows">
                {rows.map((row, i) => (
                  <li
                    className="home-comparison-card-row"
                    key={`${row.label}-${i}`}
                  >
                    <span className="home-comparison-card-label">
                      {row.label}
                    </span>
                    <span className="home-comparison-card-value">
                      <Cell row={row} value={row.values[j] ?? ""} />
                    </span>
                  </li>
                ))}
              </ul>
              <Cta column={column} />
            </div>
          ))}
        </div>
      ) : (
        <div className="home-comparison-scroll">
          <table className={`home-comparison cols-${columns.length}`}>
            <thead>
              <tr>
                <th scope="col" className="home-comparison-feature">
                  <span className="sr-only">Feature</span>
                </th>
                {columns.map((column, j) => (
                  <th
                    scope="col"
                    className={`home-comparison-col${colClass(column)}`}
                    key={`${column.label}-${j}`}
                  >
                    <span className="home-comparison-col-label">
                      {column.label}
                    </span>
                    {column.caption && (
                      <span className="home-comparison-col-caption">
                        {column.caption}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.label}-${i}`}>
                  <th scope="row" className="home-comparison-feature">
                    {row.label}
                  </th>
                  {columns.map((column, j) => (
                    <td
                      className={`home-comparison-cell${colClass(column)}`}
                      key={`${column.label}-${j}`}
                    >
                      <Cell row={row} value={row.values[j] ?? ""} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {hasCta && (
              <tfoot>
                <tr>
                  <td className="home-comparison-feature" />
                  {columns.map((column, j) => (
                    <td
                      className={`home-comparison-cell${colClass(column)}`}
                      key={`${column.label}-${j}`}
                    >
                      <Cta column={column} />
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </SectionShell>
  );
}
