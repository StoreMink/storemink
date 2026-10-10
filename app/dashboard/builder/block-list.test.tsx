// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BlockList } from "./block-list";

type Row = { title: string };

function Harness({
  items,
  onChange,
  max = 4,
}: {
  items: Row[];
  onChange: (items: Row[]) => void;
  max?: number;
}) {
  return (
    <BlockList
      label="Rows"
      itemLabel="Row"
      items={items}
      max={max}
      newItem={() => ({ title: "" })}
      onChange={onChange}
      title={(row) => row.title}
    >
      {(row, _index, setRow) => (
        <input
          aria-label="Title"
          value={row.title}
          onChange={(e) => setRow({ title: e.target.value })}
        />
      )}
    </BlockList>
  );
}

describe("BlockList", () => {
  it("starts every block collapsed, titled by its own content, and opens one on click", () => {
    render(
      <Harness items={[{ title: "Care" }, { title: "" }]} onChange={vi.fn()} />,
    );
    expect(screen.queryAllByLabelText("Title")).toHaveLength(0);
    expect(screen.getByText("Care")).toBeTruthy();
    // A block with nothing to show falls back to its numbered label.
    expect(screen.getByText("Row 2")).toBeTruthy();
    fireEvent.click(screen.getByText("Care"));
    expect(screen.getAllByLabelText("Title")).toHaveLength(1);
    expect(
      screen.getByText("Care").closest("button")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("adds a block open, and stops offering Add at the cap", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Harness items={[{ title: "Care" }]} onChange={onChange} max={2} />,
    );
    fireEvent.click(screen.getByText("Add row"));
    expect(onChange).toHaveBeenCalledWith([{ title: "Care" }, { title: "" }]);
    rerender(
      <Harness
        items={[{ title: "Care" }, { title: "" }]}
        onChange={onChange}
        max={2}
      />,
    );
    // The new block is the one that is open.
    expect(screen.getAllByLabelText("Title")).toHaveLength(1);
    expect(screen.queryByText("Add row")).toBeNull();
    expect(screen.getByText("(2/2)")).toBeTruthy();
  });

  it("writes a block's edits through the patch setter", () => {
    const onChange = vi.fn();
    render(<Harness items={[{ title: "Care" }]} onChange={onChange} />);
    fireEvent.click(screen.getByText("Care"));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Care and wear" },
    });
    expect(onChange).toHaveBeenCalledWith([{ title: "Care and wear" }]);
  });

  it("moves and removes blocks, keeping open state with the block that moved", () => {
    const onChange = vi.fn();
    const items = [{ title: "A" }, { title: "B" }, { title: "C" }];
    const { rerender } = render(<Harness items={items} onChange={onChange} />);
    fireEvent.click(screen.getByText("B"));
    const [, moveDownB] = screen.getAllByTitle("Move down");
    fireEvent.click(moveDownB);
    expect(onChange).toHaveBeenLastCalledWith([
      { title: "A" },
      { title: "C" },
      { title: "B" },
    ]);
    rerender(
      <Harness
        items={[{ title: "A" }, { title: "C" }, { title: "B" }]}
        onChange={onChange}
      />,
    );
    // B moved to the third slot and is still the open one.
    const rows = document.querySelectorAll("[data-block-open]");
    expect([...rows].map((r) => r.getAttribute("data-block-open"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(screen.getAllByTitle("Move up")[0].hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getAllByTitle("Move down")[2].hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(screen.getAllByTitle("Remove")[0]);
    expect(onChange).toHaveBeenLastCalledWith([{ title: "C" }, { title: "B" }]);
  });
});
