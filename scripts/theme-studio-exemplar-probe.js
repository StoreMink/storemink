/* eslint-disable */
// The in-page half of scripts/theme-studio-exemplar-check.ts: the acceptance
// probe's deterministic rules (app/(storefront)/components/studio-acceptance-
// probe.tsx), mirrored for a store that is not a Studio preview; the gates in
// lib/theme-studio/acceptance-gates.ts apply the thresholds. Plain JavaScript
// in its own file because the check script runs under tsx, whose transform
// injects helpers (`__name`) that do not exist inside the page; Playwright
// evaluates this file's text as one expression and invokes the function.
async ({ home }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.dispatchEvent(new Event("sm:reveal-all"));
  const step = Math.max(200, Math.floor(innerHeight * 0.8));
  for (
    let y = 0;
    y < document.documentElement.scrollHeight && y < 4e4;
    y += step
  ) {
    scrollTo(0, y);
    await sleep(60);
  }
  scrollTo(0, 0);
  // Bounded, as the probe's settleImages is: a lazy image that never
  // intersects never loads, and its decode() never resolves.
  await Promise.race([
    Promise.all(
      [...document.images].map((i) =>
        i.complete ? null : i.decode().catch(() => null),
      ),
    ),
    sleep(6000),
  ]);
  await sleep(800);
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const cls = el.className;
    return `${tag}${typeof cls === "string" && cls ? "." + cls.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
  };
  const root = document.documentElement;
  const docOverflow =
    Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) -
    root.clientWidth;
  const offenders = [];
  let rectOverflow = 0;
  for (const el of document.body.querySelectorAll("*")) {
    if (offenders.length >= 5) break;
    const style = getComputedStyle(el);
    if (style.position === "fixed" || style.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.right <= innerWidth + 1) continue;
    let clipped = false;
    for (
      let p = el.parentElement;
      p && p !== document.body;
      p = p.parentElement
    ) {
      const ps = getComputedStyle(p);
      // A fixed ancestor (an off-canvas drawer, a sheet) is not page
      // overflow, and nor is anything a fitting scroll container clips.
      if (
        ps.position === "fixed" ||
        (/(auto|scroll|hidden|clip)/.test(ps.overflowX) &&
          p.getBoundingClientRect().right <= innerWidth + 1)
      ) {
        clipped = true;
        break;
      }
    }
    if (clipped) continue;
    rectOverflow = Math.max(rectOverflow, rect.right - innerWidth);
    offenders.push(describe(el));
  }
  const overflowPx = Math.max(docOverflow, rectOverflow);
  const targets = [];
  if (innerWidth <= 768) {
    const selector =
      'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"]';
    for (const el of document.querySelectorAll(selector)) {
      if (targets.length >= 60) break;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0 ||
        rect.width === 0 ||
        rect.height === 0 ||
        el.matches(":disabled") ||
        style.display === "inline"
      )
        continue;
      if (rect.width < 24 || rect.height < 24) {
        if (
          el instanceof HTMLInputElement &&
          (el.type === "checkbox" || el.type === "radio") &&
          [...(el.labels ?? [])].some((label) => {
            const box = label.getBoundingClientRect();
            return box.width >= 24 && box.height >= 24;
          })
        )
          continue;
        targets.push({
          target: describe(el),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    }
  }
  const crops = [];
  for (const image of document.images) {
    const rect = image.getBoundingClientRect();
    if (
      !image.naturalWidth ||
      rect.width < 80 ||
      rect.height < 80 ||
      getComputedStyle(image).objectFit !== "cover"
    )
      continue;
    const s = image.naturalWidth / image.naturalHeight;
    const f = rect.width / rect.height;
    const retained = Math.min(s / f, f / s);
    if (retained < 0.35)
      crops.push({
        target: describe(image),
        retained: Math.round(retained * 1e3) / 1e3,
      });
  }
  const broken = [...document.images].filter(
    (i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src),
  ).length;
  const run = async (context) => {
    const results = await window.axe.run(context, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
      resultTypes: ["violations"],
    });
    return results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.slice(0, 3).map((n) => ({
          target: n.target.join(" "),
          summary: (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160),
        })),
      }));
  };
  const violations = await run({ exclude: [["nextjs-portal"]] });
  const states = [];
  if (home) {
    const specs = [
      {
        state: "menu",
        trigger: 'button[aria-label="Open Menu"]',
        panel: '[data-sm="menu-drawer"]',
        close: 'button[aria-label="Close Menu"]',
      },
      {
        state: "search",
        trigger: 'button[aria-label="Search"][aria-haspopup="dialog"]',
        panel: '[role="dialog"][aria-label="Search the store"]',
        close: 'button[aria-label="Close search"]',
      },
      {
        state: "cart",
        trigger: 'button[aria-label="Open cart"]',
        panel: '[role="dialog"][aria-label="Shopping cart"]',
        close: 'button[aria-label="Close cart"]',
      },
      {
        state: "account",
        trigger: "#header-profile-btn",
        panel: "#profile-dropdown",
        close: "#header-profile-btn",
      },
    ];
    const onScreen = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        parseFloat(s.opacity) === 0
      )
        return false;
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < innerWidth &&
        r.top < innerHeight
      );
    };
    const until = async (f, ms) => {
      for (let t = 0; t <= ms; t += 100) {
        if (f()) return true;
        await sleep(100);
      }
      return false;
    };
    for (const spec of specs) {
      const trigger = document.querySelector(spec.trigger);
      if (!trigger) {
        states.push({ state: spec.state, reason: "absent" });
        continue;
      }
      if (!onScreen(trigger)) {
        states.push({ state: spec.state, reason: "hidden" });
        continue;
      }
      trigger.click();
      const appeared = () => onScreen(document.querySelector(spec.panel));
      if (!(await until(appeared, 2500))) {
        states.push({ state: spec.state, reason: "unopened" });
        continue;
      }
      await sleep(500);
      const panel = document.querySelector(spec.panel);
      const panelViolations = await run(panel);
      const small = [];
      if (innerWidth <= 768)
        for (const el of panel.querySelectorAll(
          'a[href],button,input:not([type="hidden"])',
        )) {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          if (
            r.width &&
            r.height &&
            s.display !== "inline" &&
            (r.width < 24 || r.height < 24)
          )
            small.push(
              `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            );
        }
      const closer = spec.close ? document.querySelector(spec.close) : null;
      if (closer && onScreen(closer)) closer.click();
      else
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
      const gone = await until(
        () => !onScreen(document.querySelector(spec.panel)),
        1500,
      );
      states.push({
        state: spec.state,
        measured: true,
        violations: panelViolations,
        smallTargets: small,
        ...(gone ? {} : { reason: "stuck" }),
      });
      if (!gone) break;
    }
  }
  return {
    overflowPx: Math.round(overflowPx),
    offenders,
    targets,
    crops,
    broken,
    violations,
    states,
  };
};
