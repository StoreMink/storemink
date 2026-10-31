// @vitest-environment jsdom
import { Children, isValidElement, type ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { themeStudioMessages, themeStudioProjects } from "@/drizzle/schema";

// ---------------------------------------------------------------------------
// New theme, the page (wave TS-2, builder 2D): superadmin before any read;
// "Start from a theme" lists only the bundled themes the server accepts;
// `?from=` fills the form from that theme, read on the server; the time
// sentence comes from the build-time range, with the benchmark when the
// range can't be read; building switched off reaches the form.
// ---------------------------------------------------------------------------

const PROJECT = "0f9b5c1e-4a7d-4c2b-9e1f-3a2b1c0d9e8f";

const data = vi.hoisted(() => ({
  actor: { id: "a-1", email: "op@storemink.com" } as {
    id: string;
    email: string;
  } | null,
  config: {
    generationEnabled: true,
    provider: "vertex-gemini" as string | null,
    disabledModels: new Set<string>(),
  },
  range: { fromMinutes: 40, toMinutes: 60, basedOn: 10, source: "measured" },
  rangeFails: false,
  project: null as Record<string, unknown> | null,
  message: null as { body: string } | null,
  reads: [] as string[],
  formProps: null as Record<string, unknown> | null,
}));

vi.mock("../../../require-operator", () => ({
  requireOperator: vi.fn(async () => ({
    email: "op@storemink.com",
    role: "superadmin",
  })),
}));
vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => data.actor),
}));
vi.mock("@/lib/theme-studio/config", () => ({
  getThemeStudioConfig: () => data.config,
  isImplementedProvider: (provider: string | null) => provider !== null,
}));
vi.mock("@/lib/theme-studio/progress", () => ({
  readThemeStudioBuildTimeRange: vi.fn(async () => {
    data.reads.push("range");
    if (data.rangeFails) throw new Error("db down");
    return data.range;
  }),
}));
vi.mock("@/lib/theme-studio/repository", () => ({
  isUuid: (value: unknown) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  // The runtime catalogue lists published Studio themes, which the server
  // refuses as a starting point: New theme must not read it.
  getThemeCatalog: vi.fn(async () => {
    throw new Error("New theme must not list the runtime catalogue");
  }),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("../studio-ui", () => ({
  SuperadminOnly: () => <p>Theme Studio is limited to superadmins</p>,
}));
vi.mock("../studio-words", () => ({
  buildTimeWords: (range: { fromMinutes: number; toMinutes: number }) =>
    `Usually ${range.fromMinutes} to ${range.toMinutes} minutes.`,
}));
vi.mock("./new-project-form", () => ({
  NewProjectForm: (props: Record<string, unknown>) => {
    data.formProps = props;
    return <div data-testid="form" />;
  },
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => unknown) =>
    fn({
      select: () => ({
        from: (table: unknown) => {
          const rows = () => {
            if (table === themeStudioProjects) {
              data.reads.push("project");
              return data.project ? [data.project] : [];
            }
            if (table === themeStudioMessages) {
              data.reads.push("message");
              return data.message ? [data.message] : [];
            }
            return [];
          };
          const chain = {
            where: () => chain,
            orderBy: () => chain,
            limit: async () => rows(),
          };
          return chain;
        },
      }),
    }),
  ),
}));

import NewThemeStudioProjectPage from "./page";
import { logError } from "@/lib/observability/logger";

/** Render the page, including its async inner part (a server component). */
async function open(search: Record<string, string> = {}) {
  const page = (await NewThemeStudioProjectPage({
    searchParams: Promise.resolve(search),
  })) as ReactElement<{ children: unknown }>;
  const resolve = async (node: unknown): Promise<unknown> => {
    if (Array.isArray(node)) return Promise.all(node.map(resolve));
    if (!isValidElement(node)) return node;
    const element = node as ReactElement<{ children?: unknown }>;
    if (
      typeof element.type === "function" &&
      (element.type as { name: string }).name === "NewTheme"
    ) {
      const inner = await (
        element.type as (props: unknown) => Promise<unknown>
      )(element.props);
      return resolve(inner);
    }
    if (element.props?.children === undefined) return element;
    const children = await resolve(
      Children.toArray(element.props.children as never),
    );
    return { ...element, props: { ...element.props, children } };
  };
  return render((await resolve(page)) as ReactElement);
}

afterEach(() => {
  cleanup();
  data.actor = { id: "a-1", email: "op@storemink.com" };
  data.config = {
    generationEnabled: true,
    provider: "vertex-gemini",
    disabledModels: new Set(),
  };
  data.range = {
    fromMinutes: 40,
    toMinutes: 60,
    basedOn: 10,
    source: "measured",
  };
  data.rangeFails = false;
  data.project = null;
  data.message = null;
  data.reads = [];
  data.formProps = null;
});

describe("New theme, the page", () => {
  it("shows a member today's notice and reads nothing", async () => {
    data.actor = null;
    await open({ from: PROJECT });
    expect(
      screen.getByText("Theme Studio is limited to superadmins"),
    ).toBeTruthy();
    expect(screen.queryByTestId("form")).toBeNull();
    expect(data.reads).toEqual([]);
  });

  it("says the usual build time from this deployment's builds", async () => {
    const view = await open();
    // The Studio's root class: 44 px controls on touch screens of any width.
    expect(
      view.container.firstElementChild?.classList.contains("studio-root"),
    ).toBe(true);
    expect(
      screen.getByText(
        /Theme Studio designs the theme, draws its pictures and checks every page\. Usually 40 to 60 minutes\./,
      ),
    ).toBeTruthy();
    expect(data.reads).toEqual(["range"]);
  });

  it("falls back to the 35 to 75 minute benchmark when the range can't be read", async () => {
    data.rangeFails = true;
    await open();
    expect(screen.getByText(/Usually 35 to 75 minutes\./)).toBeTruthy();
    expect(logError).toHaveBeenCalled();
    expect(screen.getByTestId("form")).toBeTruthy();
  });

  it("offers only the bundled themes as a starting point", async () => {
    await open();
    expect(data.formProps?.baseThemes).toEqual([
      { id: "basket", name: "Basket" },
      { id: "studio", name: "Studio" },
      { id: "ritual", name: "Ritual" },
      { id: "vitrine", name: "Vitrine" },
    ]);
  });

  it("offers only the models this deployment has switched on", async () => {
    data.config.disabledModels = new Set(["gemini-3.1-pro"]);
    await open();
    expect(
      (data.formProps?.models as { key: string }[]).map((m) => m.key),
    ).toEqual(["gemini-3.8-flash"]);
    expect(data.formProps?.buildingOff).toBe(false);
    expect(data.formProps?.limits).toEqual({
      files: 10,
      fileBytes: 10 * 1024 * 1024,
      totalBytes: 40 * 1024 * 1024,
    });
  });

  it("tells the form when building is switched off, and why", async () => {
    data.config.generationEnabled = false;
    await open();
    expect(data.formProps?.buildingOff).toBe(true);
    expect(data.formProps?.buildingOffReason).toBe(
      "Building is switched off on this deployment.",
    );
  });

  it("treats every model switched off as building switched off", async () => {
    data.config.disabledModels = new Set([
      "gemini-3.8-flash",
      "gemini-3.1-pro",
    ]);
    await open();
    expect(data.formProps?.buildingOff).toBe(true);
    expect(data.formProps?.buildingOffReason).toBe(
      "Every model is switched off on this deployment.",
    );
    expect((data.formProps?.models as unknown[]).length).toBe(2);
  });
});

describe("Start a new theme from this brief (?from=)", () => {
  const aurora = {
    name: "Aurora",
    industries: ["beauty", "not-an-industry", "wellness"],
    catalogSizes: ["medium", "huge"],
    requiredFeatures: ["faq", "teleport"],
    baseThemeId: "vitrine",
    modelKey: "gemini-3.1-pro",
    draftBrief: "The saved draft brief.",
  };

  it("reads the theme on the server and fills the form from its first brief", async () => {
    data.project = aurora;
    data.message = { body: "A calm skincare shop for sensitive skin." };
    await open({ from: PROJECT });
    expect(data.reads).toEqual(["range", "project", "message"]);
    expect(data.formProps?.initial).toEqual({
      name: "Aurora 2",
      brief: "A calm skincare shop for sensitive skin.",
      industries: ["beauty", "wellness"],
      catalogSizes: ["medium"],
      requiredFeatures: ["faq"],
      baseThemeId: "vitrine",
      modelKey: "gemini-3.1-pro",
    });
    expect(
      screen.getByText(
        "Filled in from Aurora. Check the name and the brief, then create.",
      ),
    ).toBeTruthy();
  });

  it("uses the draft brief when nothing was sent, and drops what is no longer offered", async () => {
    data.project = {
      ...aurora,
      baseThemeId: "aurora-live", // a published Studio theme: not bundled
      catalogSizes: ["huge"],
    };
    data.config.disabledModels = new Set(["gemini-3.1-pro"]);
    await open({ from: PROJECT });
    expect(data.formProps?.initial).toMatchObject({
      brief: "The saved draft brief.",
      baseThemeId: null,
      catalogSizes: ["small"],
      modelKey: null,
    });
  });

  it("never reads an address that is not a theme id, and says nothing was filled", async () => {
    await open({ from: "A calm skincare shop" });
    expect(data.reads).toEqual(["range"]);
    expect(data.formProps?.initial).toBeNull();
    expect(
      screen.getByText(
        "That theme could not be found, so the form starts empty.",
      ),
    ).toBeTruthy();
  });

  it("starts empty when the theme is gone", async () => {
    await open({ from: PROJECT });
    expect(data.reads).toEqual(["range", "project"]);
    expect(data.formProps?.initial).toBeNull();
    expect(
      screen.getByText(
        "That theme could not be found, so the form starts empty.",
      ),
    ).toBeTruthy();
  });
});
