// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreBrand } from "@/lib/store/brand";

// The Branding page's editor. First the Credit line field's words, per plan
// (the storefront rule is lib/store/footer-credit.ts: Free always shows
// "Powered by StoreMink", Basic and Pro show the store's own line or nothing),
// then the one save bar the whole page shares.
const H = vi.hoisted(() => ({
  saveBranding: vi.fn<
    (form: FormData) => Promise<{ success?: boolean; error?: string }>
  >(async () => ({ success: true })),
  saveVoice: vi.fn<
    (input: unknown) => Promise<{ success?: boolean; error?: string }>
  >(async () => ({ success: true })),
  generate: vi.fn<
    (answers: unknown) => Promise<{ content?: string; error?: string }>
  >(async () => ({ content: "Warm and plain." })),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/app/actions/store-branding", () => ({
  saveStoreBranding: (form: FormData) => H.saveBranding(form),
}));
vi.mock("@/app/actions/brand-voice-actions", () => ({
  saveBrandVoice: (input: unknown) => H.saveVoice(input),
  generateBrandVoice: (answers: unknown) => H.generate(answers),
}));
vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: H.refresh }),
}));
vi.mock("sonner", () => ({ toast: { success: (m: string) => H.toast(m) } }));

import { BrandingForm } from "./branding-form";

const BRAND: StoreBrand = {
  name: "Acme Foods",
  logoUrl: null,
  primaryColor: "#17130f",
  tagline: null,
  blurb: null,
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "storemink.com",
};

const VOICE = { content: "", structured: {} };

function renderForm(
  removeBadge: boolean | null,
  brand: Partial<StoreBrand> = {},
) {
  render(
    <BrandingForm
      initial={{ ...BRAND, ...brand }}
      voice={VOICE}
      canManage
      removeBadge={removeBadge}
    />,
  );
  const input = screen.getByLabelText("Credit line") as HTMLInputElement;
  return { input, hint: hintOf(input) };
}

/** The hint the field names with aria-describedby, as it reads now. */
function hintOf(input: HTMLInputElement): string | null {
  const hintId = input.getAttribute("aria-describedby");
  const hint = hintId ? document.getElementById(hintId) : null;
  return hint?.textContent ?? null;
}

const PAID_HINT =
  "Shown at the very bottom of your store. Leave it empty to show nothing.";
const BADGE_WORDS_HINT =
  "These are the words of StoreMink's badge, so nothing shows at the very bottom of your store. Type a line of your own, or leave it empty.";

describe("BrandingForm Credit line", () => {
  it("on Free, says the store shows Powered by StoreMink and what Basic or Pro allow", () => {
    const { input, hint } = renderForm(false);
    expect(hint).toBe(
      "Your store shows Powered by StoreMink here on the Free plan. On Basic or Pro you can show your own line, or nothing.",
    );
    expect(input.placeholder).toBe("Powered by StoreMink");
  });

  it("★ on Basic or Pro, says an empty field shows nothing, and the placeholder never suggests the badge", () => {
    const { input, hint } = renderForm(true);
    expect(hint).toBe(PAID_HINT);
    expect(input.placeholder).not.toMatch(/storemink/i);
    expect(input.placeholder).not.toMatch(/powered by/i);
  });

  it("★ on Basic or Pro, says a saved line of only the badge's words shows nothing, never that it is shown", () => {
    // The storefront's own test (isDefaultCreditWords): any case or spacing.
    for (const saved of [
      "Powered by StoreMink",
      "powered  by Store Mink",
      " POWERED BY STOREMINK ",
    ]) {
      const { input, hint } = renderForm(true, { creditLine: saved });
      expect(input.value, saved).toBe(saved);
      expect(hint, saved).toBe(BADGE_WORDS_HINT);
      cleanup();
    }
  });

  it("follows what is typed: the badge's words switch the hint, a line of the store's own switches it back", () => {
    const { input } = renderForm(true);
    expect(hintOf(input)).toBe(PAID_HINT);
    fireEvent.change(input, { target: { value: "Powered by StoreMink" } });
    expect(hintOf(input)).toBe(BADGE_WORDS_HINT);
    fireEvent.change(input, { target: { value: "Made with care in Pune" } });
    expect(hintOf(input)).toBe(PAID_HINT);
    fireEvent.change(input, { target: { value: "" } });
    expect(hintOf(input)).toBe(PAID_HINT);
  });

  it("on Free, the badge's words in the field change nothing: the badge shows either way", () => {
    const { hint } = renderForm(false, { creditLine: "Powered by StoreMink" });
    expect(hint).toBe(
      "Your store shows Powered by StoreMink here on the Free plan. On Basic or Pro you can show your own line, or nothing.",
    );
  });

  it("keeps a Free store's own saved line in the field, so it returns on an upgrade", () => {
    const { input, hint } = renderForm(false, {
      creditLine: "Made with care in Pune",
    });
    expect(input.value).toBe("Made with care in Pune");
    expect(hint).toContain("Free plan");
  });

  it("states both rules when the plan could not be read", () => {
    const { input, hint } = renderForm(null);
    expect(hint).toBe(
      "Shown at the very bottom of your store on Basic and Pro. On the Free plan, Powered by StoreMink shows here instead.",
    );
    expect(input.placeholder).toBe("");
  });

  it("uses no long or en dash in the words it shows", () => {
    for (const [removeBadge, creditLine] of [
      [false, null],
      [true, null],
      [true, "Powered by StoreMink"],
      [null, null],
    ] as const) {
      const { container } = render(
        <BrandingForm
          initial={{ ...BRAND, creditLine }}
          voice={VOICE}
          canManage
          removeBadge={removeBadge}
        />,
      );
      const words = [
        container.textContent ?? "",
        ...Array.from(container.querySelectorAll("input")).map(
          (el) => el.placeholder,
        ),
      ].join(" ");
      expect(words).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

function renderEditor(
  props: {
    brand?: Partial<StoreBrand>;
    voice?: { content: string; structured: Record<string, string> };
    canManage?: boolean;
    removeBadge?: boolean | null;
  } = {},
) {
  return render(
    <BrandingForm
      initial={{ ...BRAND, ...props.brand }}
      voice={props.voice ?? VOICE}
      canManage={props.canManage ?? true}
      removeBadge={props.removeBadge ?? true}
    />,
  );
}

const saveBar = () => screen.queryByText("Unsaved changes");

describe("BrandingForm save bar", () => {
  beforeEach(() => {
    H.saveBranding.mockImplementation(async () => ({ success: true }));
    H.saveVoice.mockImplementation(async () => ({ success: true }));
    H.generate.mockImplementation(async () => ({ content: "Warm and plain." }));
  });

  it("shows only once something differs from what was saved, and hides again when it matches", () => {
    renderEditor();
    expect(saveBar()).toBeNull();
    const tagline = screen.getByLabelText("Tagline");
    fireEvent.change(tagline, { target: { value: "Fresh every day" } });
    expect(saveBar()).not.toBeNull();
    fireEvent.change(tagline, { target: { value: "" } });
    expect(saveBar()).toBeNull();
  });

  it("Discard puts every field back as it was saved", () => {
    renderEditor({ brand: { tagline: "Old line" } });
    const tagline = screen.getByLabelText("Tagline") as HTMLInputElement;
    fireEvent.change(tagline, { target: { value: "New line" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(tagline.value).toBe("Old line");
    expect(saveBar()).toBeNull();
  });

  it("saves branding with every field the server reads, trimmed and with links given a scheme", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Tagline"), {
      target: { value: "  Fresh every day  " },
    });
    fireEvent.change(screen.getByLabelText("Instagram"), {
      target: { value: "instagram.com/acme" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(H.saveBranding).toHaveBeenCalledTimes(1);
    const form = H.saveBranding.mock.calls[0][0] as FormData;
    expect(form.get("name")).toBe("Acme Foods");
    expect(form.get("tagline")).toBe("Fresh every day");
    expect(form.get("instagram")).toBe("https://instagram.com/acme");
    expect(form.get("primaryColor")).toBe("#17130f");
    for (const key of [
      "logoUrl",
      "blurb",
      "legalName",
      "creditLine",
      "email",
      "phone",
      "hours",
      "youtube",
      "whatsapp",
    ]) {
      expect(form.has(key), key).toBe(true);
    }
    expect(H.saveVoice).not.toHaveBeenCalled();
    expect(H.toast).toHaveBeenCalledWith("Branding saved.");
    expect(H.refresh).toHaveBeenCalled();
    expect(saveBar()).toBeNull();
    expect((screen.getByLabelText("Instagram") as HTMLInputElement).value).toBe(
      "https://instagram.com/acme",
    );
  });

  it("refuses to save without a store name and says where", async () => {
    renderEditor();
    const name = screen.getByLabelText("Store name");
    fireEvent.change(name, { target: { value: "  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(H.saveBranding).not.toHaveBeenCalled();
    expect(screen.getByText("Add your store name.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Fix the highlighted fields",
    );
    expect(name.getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses an email that is not an address", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "hello at acme" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(H.saveBranding).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter an email address like hello@yourstore.com."),
    ).toBeTruthy();
  });

  it("keeps the changes and shows the server's reason when a save fails", async () => {
    H.saveBranding.mockImplementation(async () => ({
      error: "Store name is required.",
    }));
    renderEditor();
    fireEvent.change(screen.getByLabelText("Tagline"), {
      target: { value: "Fresh" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(saveBar()).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Store name is required.",
    );
    expect(H.toast).not.toHaveBeenCalled();
  });

  it("saves only the brand voice when only the voice changed", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("What do you sell?"), {
      target: { value: "Cold-pressed oils" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(H.saveBranding).not.toHaveBeenCalled();
    expect(H.saveVoice).toHaveBeenCalledWith({
      content: "",
      structured: {
        sell: "Cold-pressed oils",
        audience: "",
        personality: "",
        why: "",
        avoid: "",
      },
    });
    expect(H.toast).toHaveBeenCalledWith(
      "Brand voice saved. Mink AI now writes in it.",
    );
  });

  it("★ when one part fails, the part that saved stays saved and only the failed one is offered again", async () => {
    H.saveVoice.mockImplementation(async () => ({ error: "Guide too long." }));
    renderEditor();
    fireEvent.change(screen.getByLabelText("Tagline"), {
      target: { value: "Fresh" },
    });
    fireEvent.change(screen.getByLabelText("Who buys it?"), {
      target: { value: "Families" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(H.toast).toHaveBeenCalledWith("Branding saved.");
    expect(screen.getByRole("alert").textContent).toContain("Guide too long.");
    H.saveBranding.mockClear();
    H.saveVoice.mockClear();
    H.saveVoice.mockImplementation(async () => ({ success: true }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(H.saveBranding).not.toHaveBeenCalled();
    expect(H.saveVoice).toHaveBeenCalledTimes(1);
    expect(saveBar()).toBeNull();
  });
});

describe("BrandingForm primary colour", () => {
  it("takes a typed hex only once it is whole, and reads three digits as six", () => {
    renderEditor();
    const hex = screen.getByLabelText("Primary colour") as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "#1a" } });
    expect(saveBar()).toBeNull();
    fireEvent.change(hex, { target: { value: "#1a7" } });
    expect(saveBar()).not.toBeNull();
    fireEvent.blur(hex);
    expect(hex.value).toBe("#11aa77");
  });

  it("puts a half-typed colour back to the last whole one when the field is left", () => {
    renderEditor({ brand: { primaryColor: "#1F7A5A" } });
    const hex = screen.getByLabelText("Primary colour") as HTMLInputElement;
    expect(hex.value).toBe("#1f7a5a");
    fireEvent.change(hex, { target: { value: "#zz" } });
    fireEvent.blur(hex);
    expect(hex.value).toBe("#1f7a5a");
    expect(saveBar()).toBeNull();
  });
});

describe("BrandingForm brand voice", () => {
  it("asks what the store sells before generating, without calling the model", async () => {
    renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate with AI" }));
    });
    expect(H.generate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Tell us what you sell first",
    );
  });

  it("puts a generated draft in the guide and leaves it unsaved", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("What do you sell?"), {
      target: { value: "Spices" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate with AI" }));
    });
    expect(H.generate).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByLabelText("Your brand guide") as HTMLTextAreaElement).value,
    ).toBe("Warm and plain.");
    expect(H.saveVoice).not.toHaveBeenCalled();
    expect(saveBar()).not.toBeNull();
  });

  it("★ keeps the button's label for Mink AI's spotlight, and its hook", () => {
    renderEditor({ voice: { content: "Saved guide", structured: {} } });
    const button = screen.getByRole("button", { name: "Generate with AI" });
    expect(button.getAttribute("data-mink-target")).toBe(
      "generate_brand_voice",
    );
  });
});

describe("BrandingForm preview", () => {
  it("shows the store's own words where the storefront shows them", () => {
    const { container } = renderEditor({
      brand: {
        tagline: "Fresh every day",
        blurb: "From farms near Pune.",
        legalName: "Acme Foods Pvt. Ltd.",
        creditLine: "Made in Pune",
      },
    });
    const preview = container.querySelector(".bpFrame") as HTMLElement;
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    const text = preview.textContent ?? "";
    expect(text).toContain("Acme Foods | Fresh every day");
    expect(text).toContain("From farms near Pune.");
    // The storefront footer's own line: "© {year} {legal name}. All rights
    // reserved."
    expect(text).toContain(
      `© ${new Date().getFullYear()} Acme Foods Pvt. Ltd.`,
    );
    expect(text).toContain("All rights reserved.");
    expect(text).toContain("Made in Pune");
  });

  it("follows the plan for the credit line: the badge on Free, nothing for the badge's words on Basic or Pro", () => {
    const { container, unmount } = renderEditor({
      removeBadge: false,
      brand: { creditLine: "Made in Pune" },
    });
    let text = container.querySelector(".bpFrame")?.textContent ?? "";
    expect(text).toContain("Powered by StoreMink");
    expect(text).not.toContain("Made in Pune");
    unmount();
    const paid = renderEditor({
      removeBadge: true,
      brand: { creditLine: "Powered by StoreMink" },
    });
    text = paid.container.querySelector(".bpFrame")?.textContent ?? "";
    expect(text).not.toContain("Powered by StoreMink");
  });

  it("updates as the merchant types", () => {
    const { container } = renderEditor();
    fireEvent.change(screen.getByLabelText("Store name"), {
      target: { value: "Kesar Ghani" },
    });
    const preview = within(container.querySelector(".bpFrame") as HTMLElement);
    expect(preview.getAllByText("Kesar Ghani").length).toBeGreaterThan(0);
  });
});

describe("BrandingForm view only", () => {
  it("disables every field, offers no save and no AI, and says why", () => {
    const { container } = renderEditor({ canManage: false });
    for (const el of Array.from(
      container.querySelectorAll("input, textarea"),
    ) as (HTMLInputElement | HTMLTextAreaElement)[]) {
      expect(el.disabled, el.id || el.type).toBe(true);
    }
    expect(
      screen.queryByRole("button", { name: "Generate with AI" }),
    ).toBeNull();
    expect(screen.getByText(/changing them needs permission/)).toBeTruthy();
    expect(saveBar()).toBeNull();
  });
});
