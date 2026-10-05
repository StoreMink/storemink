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
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: state.refresh }),
}));
vi.mock("@/app/actions/theme-studio-actions", () => ({
  deleteThemeStudioProjectAction: state.remove,
}));
import { DeleteThemeButton } from "./delete-theme-button";
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
});
it("keeps a refused deletion visible and does not navigate", async () => {
  state.remove.mockResolvedValue({
    ok: false,
    error: "A store is using this theme.",
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
    "A store is using this theme.",
  );
  expect(state.push).not.toHaveBeenCalled();
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
