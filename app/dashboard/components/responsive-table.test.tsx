// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResponsiveTable } from "./responsive-table";
import { RowCheckbox, SelectAllCheckbox } from "./bulk-actions";

function Records({ manage = true, onSelect = () => {}, onOpen = () => {} }) {
  return (
    <ResponsiveTable className="dash-table">
      <thead>
        <tr>
          {manage && (
            <th className="dash-checkbox-cell">
              <SelectAllCheckbox
                checked={false}
                indeterminate={false}
                onChange={onSelect}
              />
            </th>
          )}
          <>
            <th>Image</th>
            <th>Product</th>
          </>
          <th>Price</th>
          {manage && <th className="dash-col-actions">Actions</th>}
        </tr>
      </thead>
      <tbody>
        <tr onClick={onOpen}>
          {manage && (
            <td className="dash-checkbox-cell">
              <RowCheckbox
                checked={false}
                onToggle={onSelect}
                label="Select shirt"
              />
            </td>
          )}
          <>
            <td>Photo</td>
            <td>Shirt</td>
          </>
          <td>₹999</td>
          {manage && (
            <td className="dash-col-actions">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect();
                }}
              >
                Edit
              </button>
            </td>
          )}
        </tr>
        <tr>
          <td colSpan={manage ? 5 : 3}>No more records</td>
        </tr>
      </tbody>
    </ResponsiveTable>
  );
}

describe("ResponsiveTable", () => {
  it.each([true, false])(
    "labels conditional columns correctly (manage=%s)",
    (manage) => {
      render(<Records manage={manage} />);
      const row = screen.getByRole("row", { name: /Shirt/ });
      const price = within(row).getByRole("cell", { name: "₹999" });
      expect(
        price
          .querySelector(".dash-mobile-cell-label")
          ?.getAttribute("data-label"),
      ).toBe("Price");
      expect(within(row).getByRole("cell", { name: "Shirt" })).toHaveAttribute(
        "data-mobile-kind",
        "primary",
      );
      expect(screen.getByText("No more records").closest("td")).toHaveAttribute(
        "data-mobile-kind",
        "full",
      );
      expect(
        screen.queryByRole("checkbox", { name: "Select all rows" }) !== null,
      ).toBe(manage);
    },
  );
  it("retains row actions and selection without opening a row", () => {
    const select = vi.fn(),
      open = vi.fn();
    render(<Records onSelect={select} onOpen={open} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select shirt" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(select).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Shirt"));
    expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(select).toHaveBeenCalledTimes(3);
  });
  it("retains a scrolling table for multi-level headers", () => {
    const { container } = render(
      <ResponsiveTable>
        <thead>
          <tr>
            <th colSpan={2}>Totals</th>
          </tr>
          <tr>
            <th>Net</th>
            <th>Gross</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1</td>
            <td>2</td>
          </tr>
        </tbody>
      </ResponsiveTable>,
    );
    expect(container.querySelector("table")).not.toHaveClass(
      "dash-table-responsive",
    );
    expect(container.querySelector("th[colspan='2']")).toBeTruthy();
  });
});
