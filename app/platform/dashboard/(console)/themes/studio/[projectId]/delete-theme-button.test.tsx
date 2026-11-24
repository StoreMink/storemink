// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: state.toast } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
}));
vi.mock("@/app/actions/theme-studio-actions", () => ({
  deleteThemeStudioProjectAction: state.remove,
}));
import { deletedMessage, DeleteThemeButton } from "./delete-theme-button";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const props = {
  projectId: "project",
  themeId: "clay-co",
  name: "Clay",
  revision: 7,
  disabled: false,
};
it("requires the exact theme ID before sending a permanent delete", async () => {
  state.remove.mockResolvedValue({ ok: true });
  render(<DeleteThemeButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  const confirm = screen.getByRole("button", {
    name: "Delete theme permanently",
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Type clay-co to confirm/), {
    target: { value: "Clay" },
  });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Type clay-co to confirm/), {
    target: { value: "clay-co" },
  });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(state.remove).toHaveBeenCalledWith({
      projectId: "project",
      expectedRevision: 7,
      confirmation: "clay-co",
    }),
  );
  await waitFor(() =>
    expect(state.push).toHaveBeenCalledWith("/dashboard/themes/studio"),
  );
  expect(state.toast).toHaveBeenCalledWith("Theme deleted for good.");
});
it("says when stores keep the deleted theme", async () => {
  state.remove.mockResolvedValue({ ok: true, storesKept: 2 });
  render(<DeleteThemeButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  fireEvent.change(screen.getByLabelText(/Type clay-co to confirm/), {
    target: { value: "clay-co" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Delete theme permanently" }),
  );
  await waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      "Theme deleted. The 2 stores using it keep it as it is.",
    ),
  );
  expect(deletedMessage(0)).toBe("Theme deleted for good.");
  expect(deletedMessage(1)).toBe(
    "Theme deleted. The store using it keeps it as it is.",
  );
});
it("asks a phone keyboard not to capitalise or correct the ID, and says why Delete waits", () => {
  render(<DeleteThemeButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  const field = screen.getByLabelText(
    /Type clay-co to confirm/,
  ) as HTMLInputElement;
  expect(field.getAttribute("autocapitalize")).toBe("none");
  expect(field.getAttribute("autocorrect")).toBe("off");
  expect(field.getAttribute("spellcheck")).toBe("false");
  // Nothing typed yet: the instruction above is enough.
  expect(screen.queryByText(/doesn't match yet/)).toBeNull();
  fireEvent.change(field, { target: { value: "Clay-co" } });
  const reason = screen.getByText(/doesn't match yet/);
  expect(reason.textContent).toContain("type clay-co exactly");
  expect(field.getAttribute("aria-describedby")).toBe(reason.id);
  fireEvent.change(field, { target: { value: "clay-co" } });
  expect(screen.queryByText(/doesn't match yet/)).toBeNull();
});
it("keeps a refused deletion visible, does not navigate, and starts clean when opened again", async () => {
  state.remove.mockResolvedValue({
    ok: false,
    error:
      "Wait for active work to finish or cancel it before deleting this theme.",
  });
  render(<DeleteThemeButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  fireEvent.change(screen.getByLabelText(/Type clay-co to confirm/), {
    target: { value: "clay-co" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Delete theme permanently" }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Wait for active work to finish or cancel it before deleting this theme.",
  );
  expect(state.push).not.toHaveBeenCalled();
  // The refusal shows before the request has fully settled: wait for the
  // dialog's buttons to come back before pressing one.
  const keep = screen.getByRole("button", { name: "Keep it" });
  await waitFor(() => expect((keep as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(keep);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), {
    timeout: 4000,
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  expect(
    (screen.getByLabelText(/Type clay-co to confirm/) as HTMLInputElement)
      .value,
  ).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
});
it("says what is erased and what is kept, in plain words", () => {
  render(<DeleteThemeButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  expect(screen.getByText("Delete Clay for good?")).toBeTruthy();
  const words = screen.getByText(/It can't be undone/).textContent ?? "";
  // ★ A theme stores use can be deleted, and they keep it (owner, 23 Nov 2026).
  expect(words).toMatch(/no new store can choose it/);
  expect(words).toMatch(
    /Stores already using it keep it exactly as it is, pictures included/,
  );
  expect(words).not.toMatch(/can't be deleted/);
  expect(words).not.toMatch(/version/i);
  expect(
    words.includes(String.fromCharCode(0x2014)) ||
      words.includes(String.fromCharCode(0x2013)),
  ).toBe(false);
});
it("disables deletion while work is active", () => {
  render(<DeleteThemeButton {...props} disabled />);
  expect(
    (
      screen.getByRole("button", {
        name: "Delete permanently",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
