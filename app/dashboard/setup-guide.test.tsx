// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import { launchStore } from "@/app/actions/launch-actions";
import { SetupGuide } from "./setup-guide";
import {
  evaluateLaunchChecklist,
  type LaunchChecklistItem,
  type LaunchChecklistStep,
  type LaunchFacts,
} from "@/lib/store/launch-checklist-rules";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The mobile task's form loads through next/dynamic; a synchronous stand-in
// keeps these tests about the guide, not about Firebase.
vi.mock("next/dynamic", () => ({
  default: () =>
    function VerifyPhoneFormStub({
      onVerified,
    }: {
      onVerified: (phone: string) => void;
    }) {
      return (
        <button type="button" onClick={() => onVerified("+919876543210")}>
          Stub verify
        </button>
      );
    },
}));
vi.mock("@/app/actions/launch-actions", () => ({
  launchStore: vi.fn(async () => ({ success: true })),
  regenerateStorefrontPassword: vi.fn(async () => ({ password: "newpass22" })),
}));

const item = (
  key: string,
  required: boolean,
  done: boolean,
): LaunchChecklistItem => ({
  key,
  title: `Task ${key}`,
  description: `Do ${key}`,
  href: `/dashboard/${key}`,
  action: `Go ${key}`,
  required,
  done,
});

const step = (
  key: string,
  done: boolean,
  href = `/dashboard/${key}`,
): LaunchChecklistStep => ({
  key,
  title: `Step ${key}`,
  done,
  href,
  action: `Do step ${key}`,
});

const grouped = (
  key: string,
  steps: LaunchChecklistStep[],
): LaunchChecklistItem => ({
  ...item(
    key,
    true,
    steps.every((s) => s.done),
  ),
  steps,
});

function renderGuide(items: LaunchChecklistItem[], overrides = {}) {
  const required = items.filter((i) => i.required);
  const missing = required.filter((i) => !i.done).map((i) => i.title);
  return render(
    <SetupGuide
      items={items}
      requiredDone={required.length - missing.length}
      requiredTotal={required.length}
      ready={missing.length === 0}
      missing={missing}
      canLaunch
      password="bsjchm49"
      previewUrl="https://acme.storemink.com/password"
      {...overrides}
    />,
  );
}

describe("SetupGuide", () => {
  it("opens the first unfinished required task and nothing else", () => {
    renderGuide([
      item("a", true, true),
      item("b", true, false),
      item("c", true, false),
    ]);
    // Only the open task shows its description and button.
    expect(screen.getByText("Do b")).toBeTruthy();
    expect(screen.queryByText("Do c")).toBeNull();
    expect(screen.getByRole("link", { name: "Go b" })).toBeTruthy();
    // A done task offers Review, never the primary action, once opened.
    fireEvent.click(screen.getByRole("button", { name: /Task a/ }));
    expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
  });

  it("★ hides Recommended until every required task is done, then folds it", () => {
    const { rerender, unmount } = renderGuide([
      item("a", true, false),
      item("r", false, false),
    ]);
    expect(screen.queryByText(/Recommended/)).toBeNull();
    unmount();
    void rerender;

    renderGuide([item("a", true, true), item("r", false, false)]);
    const toggle = screen.getByRole("button", { name: /Recommended/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Task r")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Task r")).toBeTruthy();
  });

  it("keeps Go live disabled until ready, and names what is missing", () => {
    renderGuide([item("a", true, false)]);
    const btn = screen.getByRole("button", { name: /Go live/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("title")).toContain("Task a");
  });

  it("enables Go live for the owner once ready, and shows the password", () => {
    renderGuide([item("a", true, true)]);
    const btn = screen.getByRole("button", { name: /Go live/ });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("bsjchm49")).toBeTruthy();
  });

  it("never offers Go live or New password to a non-owner", () => {
    renderGuide([item("a", true, true)], { canLaunch: false });
    expect(
      (screen.getByRole("button", { name: /Go live/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /New/ })).toBeNull();
  });

  it("★ the owner verifies the mobile task in place, then the next task opens", () => {
    renderGuide([item("phone", true, false), item("b", true, false)], {
      ownerCanVerifyPhone: true,
    });
    // Inline form, not a link away to another page.
    expect(screen.queryByRole("link", { name: "Go phone" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stub verify" }));
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("Do b")).toBeTruthy();
  });

  it("tells anyone but the owner who verifies the mobile, and offers no form", () => {
    renderGuide([item("phone", true, false)], { ownerCanVerifyPhone: false });
    expect(screen.queryByRole("button", { name: "Stub verify" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Go phone" })).toBeNull();
    expect(
      screen.getByText(/store owner verifies their own mobile number/),
    ).toBeTruthy();
  });

  it("a verified mobile task offers Review, like any finished task", () => {
    renderGuide([item("phone", true, true), item("b", true, false)], {
      ownerCanVerifyPhone: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /Task phone/ }));
    expect(screen.getByRole("link", { name: "Review" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stub verify" })).toBeNull();
  });

  it("★ a grouped task shows n of m, a mark per step and ONE shared button", () => {
    renderGuide([
      grouped("policies", [
        step("terms", true, "/dashboard/settings/policies"),
        step("refund", false, "/dashboard/settings/policies"),
        step("shipping", true, "/dashboard/settings/policies"),
        step("privacy", false, "/dashboard/settings/policies"),
      ]),
    ]);
    const row = screen.getByRole("button", { name: /Task policies/ });
    expect(row.textContent).toContain("2 of 4");
    const steps = within(screen.getByRole("list", { name: /steps/ }));
    expect(steps.getAllByRole("listitem")).toHaveLength(4);
    // Each step says whether it is done, not just how it looks.
    expect(steps.getByText("Step terms").parentElement?.textContent).toBe(
      "Done: Step terms",
    );
    expect(steps.getByText("Step refund").parentElement?.textContent).toBe(
      "To do: Step refund",
    );
    // One page, one button: the task's own action, not four step buttons.
    expect(steps.queryAllByRole("link")).toHaveLength(0);
    const link = screen.getByRole("link", { name: "Go policies" });
    expect(link.getAttribute("href")).toBe("/dashboard/policies");
  });

  it("steps on different pages each get their own button, Review once done", () => {
    renderGuide([
      grouped("business", [
        step("details", true, "/dashboard/billing"),
        step("delivery", false, "/dashboard/settings/shipping"),
      ]),
    ]);
    const steps = within(screen.getByRole("list", { name: /steps/ }));
    expect(
      steps.getByRole("link", { name: "Review Step details" }).textContent,
    ).toBe("Review");
    expect(
      steps
        .getByRole("link", { name: "Do step delivery" })
        .getAttribute("href"),
    ).toBe("/dashboard/settings/shipping");
    // No extra task-level button when the steps carry their own.
    expect(screen.queryByRole("link", { name: "Go business" })).toBeNull();
  });

  it("a finished grouped task drops its count and still lists its steps", () => {
    renderGuide([
      grouped("policies", [step("terms", true), step("refund", true)]),
      item("b", true, false),
    ]);
    const row = screen.getByRole("button", { name: /Task policies/ });
    expect(row.textContent).not.toMatch(/of 2/);
    fireEvent.click(row);
    expect(screen.getByText("Step refund")).toBeTruthy();
  });

  it("★ the first unfinished task opens even when it is a grouped one", () => {
    renderGuide([
      item("phone", true, true),
      grouped("business", [step("details", false), step("delivery", false)]),
      item("c", true, false),
    ]);
    expect(screen.getByText("Do business")).toBeTruthy();
    expect(screen.queryByText("Do c")).toBeNull();
  });

  // The guide renders what the rules produce, so wire the two together once:
  // five rows, "x of 5 done", and the theme task linking to Storefront.
  it("★ with the real rules: five rows, x of 5 done, theme task first open after the mobile", () => {
    const facts: LaunchFacts = {
      plan: "free",
      ownerPhoneVerified: true,
      themeChosen: false,
      publishedProducts: 2,
      sampleProducts: 0,
      business: { name: true, address: true, email: true, phone: true },
      policies: { terms: true },
      shippingSaved: false,
      homepageEdited: false,
      logo: false,
      paymentsConnected: false,
      gstin: false,
      customDomainLive: false,
    };
    const c = evaluateLaunchChecklist(facts);
    render(
      <SetupGuide
        items={c.items}
        requiredDone={c.requiredDone}
        requiredTotal={c.requiredTotal}
        ready={c.ready}
        missing={c.missing}
        canLaunch
        password="bsjchm49"
        previewUrl="https://acme.storemink.com/password"
      />,
    );
    expect(screen.getByText("2 of 5 done")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { expanded: false }).length +
        screen.getAllByRole("button", { expanded: true }).length,
    ).toBe(5);
    expect(
      screen.getByRole("link", { name: "Choose a theme" }).getAttribute("href"),
    ).toBe("/dashboard/storefront");
    expect(
      screen.getByRole("button", { name: /Publish your store policies/ })
        .textContent,
    ).toContain("1 of 4");
    expect(
      screen.getByRole("button", { name: /Go live/ }).getAttribute("title"),
    ).toContain("Publish your store policies (Refund & Cancellation");
  });

  it("★ a server refusal names the outstanding steps in the toast", async () => {
    vi.mocked(launchStore).mockResolvedValueOnce({
      error: "Finish the required steps before going live.",
      missing: [
        "Choose your storefront theme",
        "Publish your store policies (Refund & Cancellation, Privacy)",
      ],
    });
    renderGuide([item("a", true, true)]);
    fireEvent.click(screen.getByRole("button", { name: /Go live/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      "Finish the required steps before going live. Still to do: Choose your storefront theme, Publish your store policies (Refund & Cancellation, Privacy).",
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
