// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STOP_CODES } from "../../../../studio-ui";
import {
  CatalogPictures,
  captureErrorText,
  catalogPictureState,
  type CatalogSlotSummary,
} from "./capture-panel";

// The catalogue pictures at the top of the Pictures tab (wave TS-2, builder
// 2C): what the theme catalog shows and where each came from, with no
// "Capture catalogue pictures" button (every final check takes them).

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

afterEach(() => cleanup());

const slots: CatalogSlotSummary[] = [
  {
    id: "catalog-preview",
    label: "Catalogue card",
    url: "/img/card",
    placeholder: false,
    captured: true,
  },
  {
    id: "catalog-desktop",
    label: "Desktop screenshot",
    url: null,
    placeholder: true,
    captured: false,
  },
  {
    id: "catalog-mobile",
    label: "Phone screenshot",
    url: "/img/phone",
    placeholder: false,
    captured: false,
  },
];

describe("CatalogPictures", () => {
  it("shows each catalogue picture and where it came from, with no capture button", () => {
    render(<CatalogPictures slots={slots} captureEnabled />);
    expect(
      screen.getByRole("heading", { name: "In the theme catalog" }),
    ).toBeTruthy();
    expect(screen.getByText("Taken by the checks")).toBeTruthy();
    expect(screen.getByText("Still a placeholder")).toBeTruthy();
    expect(screen.getByText("Uploaded")).toBeTruthy();
    expect(screen.getByText(/Every final check takes them again/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    for (const img of document.querySelectorAll("img"))
      expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("says to upload them where the browser job is switched off", () => {
    render(<CatalogPictures slots={slots} captureEnabled={false} />);
    expect(
      screen.getByText(/switched off on this deployment, so upload them/),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing for a theme with no catalogue pictures", () => {
    const { container } = render(<CatalogPictures slots={[]} captureEnabled />);
    expect(container.innerHTML).toBe("");
  });

  it("words a picture's state", () => {
    expect(catalogPictureState(slots[0])).toBe("Taken by the checks");
    expect(catalogPictureState(slots[1])).toBe("Still a placeholder");
    expect(catalogPictureState(slots[2])).toBe("Uploaded");
  });
});

describe("captureErrorText", () => {
  it("has a sentence for every capture stop code, and for none or an unknown one", () => {
    for (const code of [...STOP_CODES.capture, null, "made_up_code"]) {
      const text = captureErrorText(code);
      expect(text, String(code)).toMatch(/\.$/);
      expect(text).not.toMatch(/made_up_code/);
      expect(text.includes(EM) || text.includes(EN)).toBe(false);
    }
  });
});
