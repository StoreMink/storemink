/** Offline layout regression for shared native section layouts and controls.
 * Install the capture job's dependencies, then run:
 *   node scripts/theme-studio-renderer-check.mjs
 * Uses local Chrome on macOS, or CHROME_EXECUTABLE_PATH / Playwright Chromium.
 * No network, credentials, database or provider calls. This is a renderer
 * fixture using production CSS, not a complete storefront quality benchmark.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const axe = readFileSync(requireJob.resolve("axe-core/axe.min.js"), "utf8");
const css = readFileSync(
  new URL(
    "../app/(storefront)/components/homepage/homepage.css",
    import.meta.url,
  ),
  "utf8",
);
const macChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync(macChrome) ? macChrome : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const failures = [];
let cases = 0;

function image(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#dad4cc"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// The product and collection pages' stylesheet, for the template fixtures
// (plan Phase 2e). Its own document builder, so the homepage fixtures above
// measure exactly the stylesheet they did.
const shopCss = readFileSync(
  new URL("../app/(storefront)/(pages)/shop/shop.css", import.meta.url),
  "utf8",
);
const blogCss = readFileSync(
  new URL("../app/(storefront)/(pages)/blogs/blogs.css", import.meta.url),
  "utf8",
);
const accountCss = readFileSync(
  new URL(
    "../app/(storefront)/components/account/account.css",
    import.meta.url,
  ),
  "utf8",
);
const documentHtmlWith = (extraCss, html, rootClass = "") =>
  documentHtml(html)
    .replace("/* shop-css */", extraCss)
    .replace(
      'class="storefront-root sm-page-width"',
      `class="storefront-root sm-page-width ${rootClass}"`,
    );
const documentHtmlShop = (html, rootClass = "") =>
  documentHtmlWith(shopCss, html, rootClass);
const documentHtml = (html) => `<!doctype html><html><head><style>
  *{box-sizing:border-box}body{margin:0;font:16px Arial}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}
  :root{--sm-ink:#211c25;--sm-ink-soft:#554d59;--sm-ink-faint:#675c6b;--sm-cream:#faf8f5;--sm-cream-deep:#efece9;--sm-border:#ccc;--sm-surface:#fff;--sm-on-ink:#fff;--sm-accent:#45243c;--sm-on-accent:#fff;--brand-primary:#45243c;--sm-shadow-rgb:30,20,30;--sm-page-width:1320px;--sm-page-cream:#faf8f5;--sm-page-cream-deep:#efece9;--sm-page-surface:#fff;--sm-page-sand:#efece9;--sm-page-tile:#efece9;--sm-page-ink:#211c25;--sm-page-ink-soft:#554d59;--sm-page-ink-faint:#675c6b;--sm-page-border:#ccc;--sm-page-on-ink:#fff;--sm-page-accent:#45243c;--sm-page-on-accent:#fff;--sm-scheme-soft-bg:#faf8f5;--sm-scheme-soft-fg:#211c25;--sm-scheme-soft-surface:#fff;--sm-scheme-soft-accent:#45243c;--sm-scheme-soft-on-accent:#fff;--sm-scheme-inverse-bg:#211c25;--sm-scheme-inverse-fg:#faf8f5;--sm-scheme-inverse-surface:#211c25;--sm-scheme-inverse-accent:#faf8f5;--sm-scheme-inverse-on-accent:#211c25}
  ${css}
  /* shop-css */
  </style></head><body><main class="storefront-root sm-page-width"><div class="home-sections">${html}</div></main></body></html>`;

// Markup follows the native sections' public classes. Synthetic media uses the
// same absolute fill behavior as next/image; all requests are blocked.
const fill = (className, ratio = "portrait") =>
  `<img class="${className}" alt="Studio ceramic vessel" src="${image(ratio === "landscape" ? 1600 : 1280, ratio === "portrait" ? 1600 : ratio === "square" ? 1280 : 1200)}" style="position:absolute;inset:0;width:100%;height:100%">`;
const heading = "Thoughtfully Crafted Everyday Essentials";
const copy =
  "Durable essentials with carefully considered details, natural materials and generous space for everyday living.";
function fixtures() {
  const out = [];
  for (const ratio of ["portrait", "square", "landscape"]) {
    for (const cols of [2, 3, 4])
      for (const layout of ["grid", "editorial"])
        out.push({
          label: `gallery/${layout}/${cols}/${ratio}`,
          html: `<div class="home-gallery layout-${layout} cols-${cols}">${Array.from({ length: 4 }, () => `<a href="/shop" class="home-gallery-card"><span class="home-gallery-media ratio-${ratio}">${fill("home-gallery-image", ratio)}</span><span class="home-gallery-caption">${copy}</span></a>`).join("")}</div>`,
        });
    for (const position of ["left", "right"])
      for (const align of ["left", "center"])
        out.push({
          label: `media-text/${position}/${align}/${ratio}`,
          html: `<div class="home-media-text media-${position} align-${align}"><div class="home-media-text-media ratio-${ratio}">${fill("home-media-text-image", ratio)}</div><div class="home-media-text-copy"><h2 class="home-media-text-heading">${heading}</h2><p class="home-media-text-body">${copy}</p><a href="/shop" class="home-media-text-cta">Explore the collection</a></div></div>`,
        });
  }
  for (const cols of [2, 3, 4])
    for (const size of ["sm", "md", "lg"])
      out.push({
        label: `tiles/${cols}/${size}`,
        html: `<div class="home-tile-grid cols-${cols} size-${size}">${Array.from({ length: 4 }, () => `<a href="/shop" class="home-tile theme-dark"><span class="home-tile-copy"><span class="home-tile-title">Everyday essentials</span><span class="home-tile-sub">${copy}</span></span></a>`).join("")}</div>`,
      });
  for (const cols of [2, 3])
    for (const layout of ["grid", "editorial"])
      out.push({
        label: `testimonials/${layout}/${cols}`,
        html: `<div class="home-testimonials layout-${layout} cols-${cols}">${Array.from({ length: 3 }, () => `<figure class="home-testimonial"><blockquote class="home-testimonial-quote">${copy}</blockquote><figcaption class="home-testimonial-attribution"><cite>Alex Morgan</cite>Verified customer</figcaption></figure>`).join("")}</div>`,
      });
  for (const theme of ["light", "dark"])
    for (const align of ["left", "center"])
      out.push({
        label: `newsletter/${theme}/${align}`,
        html: `<div class="home-newsletter theme-${theme} align-${align}"><div><h2 class="home-newsletter-heading">${heading}</h2><p class="home-newsletter-sub">${copy}</p></div><form class="home-newsletter-form"><div class="home-newsletter-fields"><input class="home-newsletter-input" type="email" aria-label="Email"><button class="home-newsletter-button">Subscribe</button></div><label class="home-newsletter-consent"><input type="checkbox"><span>Send me occasional collection news and offers. I agree to the privacy policy and can unsubscribe at any time.</span></label></form></div>`,
      });
  // Nested blocks (2026-10-09): the comparison table scrolls sideways inside
  // its own container at phone widths (never the page), its cards stack, the
  // accordion's image row keeps its picture beside the copy down to 700px and
  // under it, and media-and-text stories alternate sides.
  for (const cols of [2, 3, 4]) {
    const columns = Array.from({ length: cols }, (_, j) => ({
      label: ["Starter", "Family", "Studio", "Trade"][j],
      caption: ["For one", "For the table", "For a shop", "For a kitchen"][j],
      highlight: j === 1,
    }));
    const rows = [
      {
        type: "text",
        label: "Serves",
        values: ["One or two", "Four to six", "Eight", "Twelve or more"],
      },
      {
        type: "check",
        label: "Dishwasher safe",
        values: ["yes", "yes", "no", ""],
      },
      {
        type: "check",
        label: "Comes with a thoughtfully made lid",
        values: ["no", "yes", "yes", "yes"],
      },
    ];
    const mark = (v) =>
      `<span class="home-comparison-mark ${v === "yes" ? "is-yes" : v === "no" ? "is-no" : "is-na"}"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5"/></svg><span class="sr-only">${v === "yes" ? "Yes" : v === "no" ? "No" : "Not applicable"}</span></span>`;
    const cell = (row, j) =>
      row.type === "check" ? mark(row.values[j]) : row.values[j];
    out.push({
      label: `comparison/table/${cols}`,
      html: `<div class="home-comparison-scroll"><table class="home-comparison cols-${cols}"><thead><tr><th scope="col" class="home-comparison-feature"><span class="sr-only">Feature</span></th>${columns.map((c) => `<th scope="col" class="home-comparison-col${c.highlight ? " is-highlight" : ""}"><span class="home-comparison-col-label">${c.label}</span><span class="home-comparison-col-caption">${c.caption}</span></th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><th scope="row" class="home-comparison-feature">${row.label}</th>${columns.map((c, j) => `<td class="home-comparison-cell${c.highlight ? " is-highlight" : ""}">${cell(row, j)}</td>`).join("")}</tr>`).join("")}</tbody><tfoot><tr><td class="home-comparison-feature"></td>${columns.map((c) => `<td class="home-comparison-cell${c.highlight ? " is-highlight" : ""}"><a href="/shop" class="home-comparison-cta ${c.highlight ? "sm-btn-primary" : "sm-btn-secondary"}">Shop ${c.label}</a></td>`).join("")}</tr></tfoot></table></div>`,
    });
    out.push({
      label: `comparison/cards/${cols}`,
      html: `<div class="home-comparison-cards cols-${cols}">${columns.map((c, j) => `<div class="home-comparison-card${c.highlight ? " is-highlight" : ""}"><h3 class="home-comparison-card-title">${c.label}</h3><p class="home-comparison-card-caption">${c.caption}</p><ul class="home-comparison-card-rows">${rows.map((row) => `<li class="home-comparison-card-row"><span class="home-comparison-card-label">${row.label}</span><span class="home-comparison-card-value">${cell(row, j)}</span></li>`).join("")}</ul><a href="/shop" class="home-comparison-cta ${c.highlight ? "sm-btn-primary" : "sm-btn-secondary"}">Shop ${c.label}</a></div>`).join("")}</div>`,
    });
  }
  out.push({
    label: "accordion/open-image",
    html: `<div class="home-section-head"><h2 class="home-section-title">${heading}</h2></div><div class="home-accordion-list"><div class="home-accordion-item open"><button class="home-accordion-q" aria-expanded="true"><span>How do you care for thoughtfully crafted natural materials over many years?</span></button><div class="home-accordion-panel has-media"><p class="home-accordion-a">${copy.repeat(2)}</p><div class="home-accordion-media">${fill("home-accordion-image", "landscape")}</div></div></div><div class="home-accordion-item"><button class="home-accordion-q" aria-expanded="false"><span>Shipping and returns</span></button></div></div>`,
  });
  out.push({
    label: "media-text/stories",
    html: `<div class="home-media-stories">${["left", "right", "left"].map((position, i) => `<div class="home-media-text media-${position} align-left"><div class="home-media-text-media ratio-portrait">${fill("home-media-text-image", "portrait")}</div><div class="home-media-text-copy"><p class="home-section-eyebrow">Step ${i + 1}</p>${i === 0 ? `<h2 class="home-media-text-heading">${heading}</h2>` : `<h3 class="home-media-text-heading">${heading}</h3>`}<p class="home-media-text-body">${copy}</p><a href="/shop" class="home-media-text-cta sm-btn-primary">Explore the collection</a></div></div>`).join("")}</div>`,
  });
  // Plan Phase 2c, first slice. The marquee and the logo strip drift inside
  // an overflow-hidden band (never the page); the hotspot card opens inwards
  // near the far edges; the before/after range covers the frame as one
  // 24px+ target; the spotlight stacks on phones; the collage spans cells.
  for (const cols of [2, 3, 4])
    for (const media of ["icon", "image"])
      out.push({
        label: `multicolumn/${cols}/${media}`,
        html: `<div class="home-section-head"><h2 class="home-section-title">${heading}</h2></div><div class="home-multicolumn cols-${cols} align-center">${Array.from({ length: cols }, (_, i) => `<div class="home-multicolumn-item">${media === "image" ? `<div class="home-multicolumn-media ratio-landscape">${fill("home-multicolumn-image", "landscape")}</div>` : `<svg class="home-multicolumn-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>`}<h3 class="home-multicolumn-heading">Thoughtfully made for everyday ${i + 1}</h3><p class="home-multicolumn-body">${copy}</p><a href="/shop" class="home-multicolumn-link">Read the story</a></div>`).join("")}</div>`,
      });
  for (const size of ["sm", "md", "lg"])
    out.push({
      label: `image-marquee/${size}`,
      html: `<div class="home-marquee size-${size} speed-medium"><div class="home-marquee-track">${[false, true].map((hidden) => `<div class="home-marquee-seq"${hidden ? ' aria-hidden="true"' : ""}>${Array.from({ length: 6 }, () => `<a href="/shop" class="home-marquee-item ratio-square">${fill("home-marquee-image", "square")}</a>`).join("")}</div>`).join("")}</div></div>`,
    });
  for (const layout of ["row", "scroll"])
    out.push({
      label: `logo-strip/${layout}`,
      html:
        layout === "row"
          ? `<div class="home-logos layout-row is-monochrome"><p class="home-logos-heading">As seen in</p><div class="home-logos-row">${Array.from({ length: 5 }, () => `<a href="/shop" class="home-logo">${fill("home-logo-image", "landscape")}</a>`).join("")}</div></div>`
          : `<div class="home-logos layout-scroll"><div class="home-marquee size-sm speed-slow home-logos-scroll"><div class="home-marquee-track">${[false, true].map((hidden) => `<div class="home-marquee-seq"${hidden ? ' aria-hidden="true"' : ""}>${Array.from({ length: 5 }, () => `<span class="home-logo">${fill("home-logo-image", "landscape")}</span>`).join("")}</div>`).join("")}</div></div></div>`,
    });
  for (const [x, y, edge] of [
    [22, 30, ""],
    [84, 74, " from-right from-bottom"],
  ])
    out.push({
      label: `hotspots/${x}-${y}`,
      html: `<div class="home-hotspots ratio-landscape">${fill("home-hotspots-image", "landscape")}<div class="home-hotspot open${edge}" style="left:${x}%;top:${y}%"><button type="button" class="home-hotspot-dot" aria-expanded="true" aria-label="Jug"><span class="home-hotspot-pulse" aria-hidden="true"></span></button><div class="home-hotspot-card"><strong class="home-hotspot-title">Stoneware jug</strong><p class="home-hotspot-body">${copy}</p><a href="/shop" class="home-hotspot-link">Shop</a></div></div><div class="home-hotspot" style="left:55%;top:50%"><button type="button" class="home-hotspot-dot" aria-expanded="false" aria-label="Bowl"><span class="home-hotspot-pulse" aria-hidden="true"></span></button></div></div>`,
    });
  for (const ratio of ["landscape", "square"])
    out.push({
      label: `before-after/${ratio}`,
      html: `<div class="home-before-after ratio-${ratio}"><div class="home-before-after-layer is-after">${fill("home-before-after-image", "landscape")}</div><div class="home-before-after-layer is-before" style="clip-path:inset(0 50% 0 0)">${fill("home-before-after-image", "landscape")}</div><span class="home-before-after-label is-before">Before</span><span class="home-before-after-label is-after">After</span><div class="home-before-after-handle" style="left:50%"><span class="home-before-after-grip"></span></div><input type="range" min="0" max="100" value="50" class="home-before-after-range" aria-label="Reveal Before or After"></div>`,
    });
  for (const position of ["left", "right"])
    out.push({
      label: `spotlight/${position}`,
      html: `<div class="home-spotlight media-${position}"><a href="/shop/jug" class="home-spotlight-media">${fill("home-spotlight-image", "portrait")}</a><div class="home-spotlight-copy"><p class="home-section-eyebrow">New this season</p><h2 class="home-spotlight-heading">${heading}</h2><p class="home-spotlight-product">Stoneware jug</p><p class="home-spotlight-price"><span class="home-spotlight-from">from </span><span class="home-spotlight-selling">₹950</span><s class="home-spotlight-base">₹1,200</s></p><p class="home-spotlight-body">${copy}</p><a class="home-spotlight-cta sm-btn-primary" href="/shop/jug">View product</a></div></div>`,
    });
  for (const align of ["center", "left"])
    out.push({
      label: `countdown/${align}`,
      html: `<div class="home-countdown align-${align}"><p class="home-section-eyebrow">Limited release</p><h2 class="home-countdown-heading">${heading}</h2><p class="home-countdown-sub">${copy}</p><div class="home-countdown-tiles" role="timer">${["days", "hours", "minutes", "seconds"].map((unit) => `<div class="home-countdown-tile"><span class="home-countdown-value">12</span><span class="home-countdown-unit">${unit}</span></div>`).join("")}</div><a class="home-countdown-cta sm-btn-primary" href="/shop">Shop the drop</a></div>`,
    });
  out.push({
    label: "tiles/collage",
    html: `<div class="home-tile-grid cols-4 size-md layout-collage">${["2x2", "", "", "2x1", "1x2", "", ""].map((span) => `<a href="/shop" class="home-tile theme-dark${span ? ` span-${span}` : ""}"><span class="home-tile-copy"><span class="home-tile-title">Everyday essentials</span><span class="home-tile-sub">${copy}</span></span></a>`).join("")}</div>`,
  });
  out.push({
    label: "faq/long-text",
    html: `<div class="home-faq-filters"><button class="home-faq-pill active">Delivery and returns</button><button class="home-faq-pill">Care and materials</button></div><div class="home-faq-list"><div class="home-faq-item open"><button class="home-faq-q">How do you select and care for thoughtfully crafted natural materials?</button><p class="home-faq-a">${copy.repeat(3)}</p></div></div>`,
  });
  out.push({
    label: "rich-text/long-heading",
    html: `<div class="home-rich-text"><div class="home-rich-text-content"><h2>${heading}</h2><p>${copy.repeat(4)}</p><p><a href="/shop">Discover our thoughtfully considered collection</a></p></div></div>`,
  });
  return out;
}

async function measureNative(page) {
  return page.evaluate(async () => {
    await Promise.all([...document.images].map((i) => i.decode()));
    const targets = [...document.querySelectorAll("a,button,input")]
      .filter((e) => {
        const b = e.getBoundingClientRect();
        return b.width && b.height && getComputedStyle(e).display !== "inline";
      })
      .flatMap((e) => {
        const b = e.getBoundingClientRect();
        return b.width < 24 || b.height < 24
          ? [{ target: e.className, width: b.width, height: b.height }]
          : [];
      });
    const crop = [...document.images].flatMap((e) => {
      const b = e.getBoundingClientRect();
      const s = e.naturalWidth / e.naturalHeight;
      const f = b.width / b.height;
      const retained = Math.min(s / f, f / s);
      return retained < 0.35 ? [{ target: e.className, retained }] : [];
    });
    // A screen-reader-only label (Tailwind's sr-only: a 1px box clipped by
    // `clip`) is deliberately wider than its box; the acceptance probe
    // exempts CSS-clipped accessible labels and so does this fixture.
    const clipped = [
      ...document.querySelectorAll("h1,h2,h3,p,blockquote,span"),
    ].flatMap((e) => {
      const b = e.getBoundingClientRect();
      if (getComputedStyle(e).clip !== "auto") return [];
      return e.scrollWidth > e.clientWidth + 2 && b.width > 0
        ? [e.className]
        : [];
    });
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      targets,
      crop,
      clipped,
    };
  });
}

try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const variant of ["banner", "split"]) {
      // Desktop presets deliberately change a side-by-side frame and remain
      // repairable settings. Stacked media must retain its frame under every
      // preset; the representative desktop framing uses medium height.
      for (const height of width <= 860
        ? ["auto", "small", "medium", "large"]
        : ["medium"]) {
        for (const [sourceWidth, sourceHeight] of [
          [1280, 1600], // Aurelle's editorial story photograph
          [900, 1600],
          [1600, 900],
          [2100, 900],
        ]) {
          const label = `${width}px ${variant}/${height} ${sourceWidth}×${sourceHeight}`;
          await page.setContent(
            documentHtml(`<section class="home-section">
            <div class="home-hero variant-${variant} theme-dark align-left ${height === "auto" ? "" : `height-${height}`} ">
              <div class="home-hero-copy"><h1 class="home-hero-heading">Rooted in Quiet Luxury</h1><p class="home-hero-sub">Thoughtfully made essentials for everyday life.</p></div>
              <div class="home-hero-media"><img class="home-hero-img" alt="Editorial" src="${image(sourceWidth, sourceHeight)}" style="position:absolute;inset:0;height:100%;width:100%"></div>
            </div></section>`),
          );
          const measurement = await page.evaluate(async () => {
            const img = document.querySelector("img");
            await img.decode();
            const box = img.getBoundingClientRect();
            const source = img.naturalWidth / img.naturalHeight;
            const frame = box.width / box.height;
            return {
              retained: Math.min(source / frame, frame / source),
              overflow: document.documentElement.scrollWidth > innerWidth,
              width: box.width,
              height: box.height,
            };
          });
          cases++;
          if (
            measurement.retained < 0.35 ||
            measurement.overflow ||
            !measurement.height
          )
            failures.push({ label, ...measurement });
        }
      }
    }
    // The full-bleed hero (the opening every Studio theme uses since
    // 2026-10-09): the photo covers the band, the copy sits over it. Checked
    // at every width, both alignments, light and dark copy, the auto and
    // tall presets, contained and edge to edge: the copy must stay inside
    // the band, the image must cover it, and nothing may overflow.
    for (const alignment of ["left", "center"]) {
      for (const mode of ["dark", "light"]) {
        for (const height of ["auto", "large", "screen"]) {
          for (const bleed of [false, true]) {
            const label = `${width}px fullbleed/${alignment}/${mode}/${height}/${bleed ? "full" : "contained"}`;
            await page.setContent(
              documentHtml(`<section class="home-section ${bleed ? "is-fullbleed" : ""}">
              <div class="home-hero variant-fullbleed theme-${mode} align-${alignment} ${height === "auto" ? "" : `height-${height}`}" style="background:#2a211f">
                <div class="home-hero-bgmedia"><img class="home-hero-img" alt="Opening" src="${image(2100, 900)}" style="position:absolute;inset:0;height:100%;width:100%;object-fit:cover"></div>
                <div class="home-hero-copy"><h1 class="home-hero-heading">${heading}</h1><p class="home-hero-sub">${copy}</p><a class="home-hero-cta sm-btn-primary" href="/shop">Shop the collection</a></div>
              </div></section>`),
            );
            const measurement = await page.evaluate(async () => {
              const img = document.querySelector("img");
              await img.decode();
              const band = document.querySelector(".home-hero");
              const copyBox = document
                .querySelector(".home-hero-copy")
                .getBoundingClientRect();
              const bandBox = band.getBoundingClientRect();
              const imgBox = img.getBoundingClientRect();
              const section = document
                .querySelector(".home-section")
                .getBoundingClientRect();
              return {
                overflow: document.documentElement.scrollWidth > innerWidth,
                bandHeight: bandBox.height,
                covers:
                  Math.abs(imgBox.width - bandBox.width) < 1 &&
                  Math.abs(imgBox.height - bandBox.height) < 1,
                copyInside:
                  copyBox.left >= bandBox.left - 0.5 &&
                  copyBox.right <= bandBox.right + 0.5 &&
                  copyBox.top >= bandBox.top - 0.5 &&
                  copyBox.bottom <= bandBox.bottom + 0.5,
                edgeToEdge:
                  Math.abs(bandBox.left - section.left) < 1 &&
                  Math.abs(bandBox.right - section.right) < 1,
                radius: getComputedStyle(band).borderTopLeftRadius,
              };
            });
            cases++;
            if (
              measurement.overflow ||
              !measurement.covers ||
              !measurement.copyInside ||
              measurement.bandHeight < 300 ||
              (bleed && !measurement.edgeToEdge) ||
              measurement.radius !== "0px"
            )
              failures.push({ label, ...measurement });
          }
        }
      }
    }
    // The stacked hero (plan Phase 2d): the copy sits above a full-width
    // photograph. The picture must sit below the copy, keep a real frame
    // (21:9 on desktop, 4:3 stacked on phones) and never overflow; the
    // height presets grow the picture, never the copy.
    for (const height of width <= 860
      ? ["auto", "medium", "large"]
      : ["auto", "large"]) {
      for (const [sourceWidth, sourceHeight] of [
        [2100, 900],
        [1280, 1600],
      ]) {
        const label = `${width}px stacked/${height} ${sourceWidth}×${sourceHeight}`;
        await page.setContent(
          documentHtml(`<section class="home-section">
          <div class="home-hero variant-stacked theme-dark align-left ${height === "auto" ? "" : `height-${height}`}">
            <div class="home-hero-copy"><h1 class="home-hero-heading">${heading}</h1><p class="home-hero-sub">${copy}</p><a class="home-hero-cta sm-btn-primary" href="/shop">Shop the collection</a></div>
            <div class="home-hero-media"><img class="home-hero-img" alt="Editorial" src="${image(sourceWidth, sourceHeight)}" style="position:absolute;inset:0;height:100%;width:100%;object-fit:cover"></div>
          </div></section>`),
        );
        const measurement = await page.evaluate(async () => {
          const img = document.querySelector("img");
          await img.decode();
          const band = document
            .querySelector(".home-hero")
            .getBoundingClientRect();
          const copyBox = document
            .querySelector(".home-hero-copy")
            .getBoundingClientRect();
          const mediaBox = document
            .querySelector(".home-hero-media")
            .getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            below: mediaBox.top >= copyBox.bottom - 0.5,
            fullWidth: Math.abs(mediaBox.width - band.width) < 1,
            mediaRatio: mediaBox.width / mediaBox.height,
            mediaHeight: mediaBox.height,
          };
        });
        cases++;
        const wantRatio = width <= 860 ? 4 / 3 : 21 / 9;
        if (
          measurement.overflow ||
          !measurement.below ||
          !measurement.fullWidth ||
          !measurement.mediaHeight ||
          (height === "auto" &&
            Math.abs(measurement.mediaRatio - wantRatio) > 0.05) ||
          (height !== "auto" && measurement.mediaRatio > wantRatio + 0.05)
        )
          failures.push({ label, ...measurement });
      }
    }
    // The offset hero: the photograph covers the band and the copy card
    // sits over it, inside the band, at its lower edge (or the top under
    // content-top), both alignments, light and dark text modes (the card
    // keeps its own ink either way).
    for (const alignment of ["left", "center"]) {
      for (const mode of ["dark", "light"]) {
        for (const position of ["", "content-top"]) {
          const label = `${width}px offset/${alignment}/${mode}/${position || "bottom"}`;
          await page.setContent(
            documentHtml(`<section class="home-section">
            <div class="home-hero variant-offset theme-${mode} align-${alignment} ${position}" style="background:#2a211f">
              <div class="home-hero-bgmedia"><img class="home-hero-img" alt="Opening" src="${image(2100, 900)}" style="position:absolute;inset:0;height:100%;width:100%;object-fit:cover"></div>
              <div class="home-hero-copy"><h1 class="home-hero-heading">${heading}</h1><p class="home-hero-sub">${copy}</p><a class="home-hero-cta sm-btn-primary" href="/shop">Shop the collection</a></div>
            </div></section>`),
          );
          const measurement = await page.evaluate(async () => {
            const img = document.querySelector("img");
            await img.decode();
            const band = document
              .querySelector(".home-hero")
              .getBoundingClientRect();
            const copy = document.querySelector(".home-hero-copy");
            const copyBox = copy.getBoundingClientRect();
            const imgBox = img.getBoundingClientRect();
            const style = getComputedStyle(copy);
            // The page ink, read the way the card reads it, so the check
            // holds whatever palette the fixture carries.
            const probe = document.createElement("span");
            probe.style.color = "var(--sm-ink)";
            document.body.append(probe);
            const ink = getComputedStyle(probe).color;
            probe.remove();
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              covers:
                Math.abs(imgBox.width - band.width) < 1 &&
                Math.abs(imgBox.height - band.height) < 1,
              copyInside:
                copyBox.left >= band.left - 0.5 &&
                copyBox.right <= band.right + 0.5 &&
                copyBox.top >= band.top - 0.5 &&
                copyBox.bottom <= band.bottom + 0.5,
              atBottom: band.bottom - copyBox.bottom < band.height / 3,
              atTop: copyBox.top - band.top < band.height / 3,
              cardIsInk: style.color === ink,
              cardFill: style.backgroundColor,
            };
          });
          cases++;
          if (
            measurement.overflow ||
            !measurement.covers ||
            !measurement.copyInside ||
            (position ? !measurement.atTop : !measurement.atBottom) ||
            !measurement.cardIsInk ||
            measurement.cardFill === "rgba(0, 0, 0, 0)"
          )
            failures.push({ label, ...measurement });
        }
      }
    }
    // The split carousel (plan Phase 2d): each slide is copy on a field
    // beside its photo. At every width the active slide must hold both,
    // the photo beside the copy on desktop and above it on phones, the
    // band taking the slide's height, nothing overflowing.
    for (const mode of ["dark", "light"]) {
      for (const height of ["auto", "large"]) {
        const label = `${width}px carousel-split/${mode}/${height}`;
        await page.setContent(
          documentHtml(`<section class="home-section is-fullbleed"><div class="home-carousel has-arrows layout-split ${height === "auto" ? "" : `height-${height}`}">
          <div class="home-carousel-slide theme-${mode} is-active"><div class="home-carousel-figure"><img class="home-carousel-media" alt="Slide" src="${image(1600, 1200)}" style="position:absolute;inset:0;height:100%;width:100%;object-fit:cover"></div><div class="home-carousel-copy"><h2 class="home-carousel-heading">${heading}</h2><p class="home-carousel-sub">${copy}</p><a class="home-hero-cta sm-btn-primary" href="/shop">Shop the collection</a></div></div>
          <div class="home-carousel-slide theme-dark"><div class="home-carousel-figure"><img class="home-carousel-media" alt="Slide" src="${image(1600, 1200)}" style="position:absolute;inset:0;height:100%;width:100%;object-fit:cover"></div><div class="home-carousel-copy"><h2 class="home-carousel-heading">Second</h2></div></div>
          <button type="button" class="home-carousel-arrow is-prev" aria-label="Previous slide">‹</button><button type="button" class="home-carousel-arrow is-next" aria-label="Next slide">›</button>
          <div class="home-carousel-dots"><button class="home-carousel-dot is-active" aria-label="Go to slide 1"></button><button class="home-carousel-dot" aria-label="Go to slide 2"></button></div>
          </div></section>`),
        );
        const measurement = await page.evaluate(async () => {
          const img = document.querySelector(".is-active img");
          await img.decode();
          const band = document
            .querySelector(".home-carousel")
            .getBoundingClientRect();
          const slide = document
            .querySelector(".home-carousel-slide.is-active")
            .getBoundingClientRect();
          const figure = document
            .querySelector(".is-active .home-carousel-figure")
            .getBoundingClientRect();
          const copy = document
            .querySelector(".is-active .home-carousel-copy")
            .getBoundingClientRect();
          const hidden = document.querySelectorAll(".home-carousel-slide")[1];
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            slideFillsBand:
              Math.abs(slide.height - band.height) < 1 &&
              Math.abs(slide.width - band.width) < 1,
            figureHeight: figure.height,
            beside: figure.left >= copy.right - 0.5,
            above: figure.bottom <= copy.top + 0.5,
            copyInside:
              copy.left >= slide.left - 0.5 &&
              copy.right <= slide.right + 0.5 &&
              copy.bottom <= slide.bottom + 0.5,
            inactiveHidden: getComputedStyle(hidden).display === "none",
            figureLeft: Math.round(figure.left),
            copyRight: Math.round(copy.right),
          };
        });
        cases++;
        if (
          measurement.overflow ||
          !measurement.slideFillsBand ||
          measurement.figureHeight < 200 ||
          !(width <= 860 ? measurement.above : measurement.beside) ||
          !measurement.copyInside ||
          !measurement.inactiveHidden
        )
          failures.push({ label, ...measurement });
      }
    }
    for (const fixture of fixtures()) {
      for (const [scheme, padding, bleed] of [
        ["soft", "sm", false],
        ["inverse", "lg", true],
      ]) {
        await page.setContent(
          documentHtml(
            `<section class="home-section sm-scheme sm-scheme-${scheme} home-pad-${padding} ${bleed ? "is-fullbleed" : ""}">${fixture.html}</section>`,
          ),
        );
        const measured = await measureNative(page);
        await page.addScriptTag({ content: axe });
        const contrast = await page.evaluate(async () => {
          const { violations } = await window.axe.run(document, {
            runOnly: { type: "rule", values: ["color-contrast"] },
          });
          return violations.flatMap((v) =>
            v.nodes.map((n) => n.target.join(" ")),
          );
        });
        cases++;
        if (
          measured.overflow ||
          measured.targets.length ||
          measured.crop.length ||
          measured.clipped.length ||
          contrast.length
        )
          failures.push({
            label: `${width}px ${fixture.label}/${scheme}/${padding}/${bleed}`,
            ...measured,
            contrast,
          });
      }
    }
    // Page templates (2026-10-09, plan Phase 2e). The product gallery's five
    // shapes: on desktop the thumbnail shapes show one photo with the
    // thumbnails under or beside it, stacked and grid show every photo, the
    // carousel is the phone strip; under 860px every shape is the strip with
    // its counter. The stacked product layout puts the gallery above the
    // information column at every width.
    for (const mode of [
      "thumbs-bottom",
      "thumbs-left",
      "stacked",
      "carousel",
      "grid",
    ]) {
      for (const stacked of [false, true]) {
        if (stacked && mode !== "thumbs-bottom") continue;
        const thumbs = mode === "thumbs-bottom" || mode === "thumbs-left";
        const label = `${width}px pdp/${stacked ? "stacked/" : ""}${mode}`;
        await page.setContent(
          documentHtmlShop(
            `<main class="shop-main pdp-page"><div class="pdp-grid">
            <div class="pdp-gallery sm-gallery mode-${mode}"><div class="sm-gallery-frame"><div class="sm-gallery-track is-multi">${[0, 1, 2].map((i) => `<button class="pdp-main-img sm-gallery-slide" data-active="${i === 0}" aria-label="Zoom photo ${i + 1} of 3"><img class="pdp-main-img-el" alt="" src="${image(1280, 1600)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></button>`).join("")}</div><span class="sm-gallery-count">1 / 3</span></div>${thumbs ? `<div class="pdp-thumbs">${[0, 1, 2].map((i) => `<button class="pdp-thumb${i === 0 ? " active" : ""}" aria-label="Show photo ${i + 1} of 3"><img class="pdp-thumb-el" alt="" src="${image(400, 400)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></button>`).join("")}</div>` : ""}</div>
            <div class="pdp-info"><h1 class="pdp-name">${heading}</h1><div class="pdp-price"><span class="pdp-price-sell">₹1,800</span></div><ul class="pdp-trust"><li><span style="display:inline-block;width:18px;height:18px"></span><span>Free delivery</span></li><li><span style="display:inline-block;width:18px;height:18px"></span><span>Easy returns</span></li></ul><div class="pdp-accordion"><details class="pdp-accordion-row" open><summary>Care</summary><div class="pdp-accordion-body"><p>${copy}</p></div></details><details class="pdp-accordion-row"><summary>Shipping</summary><div class="pdp-accordion-body"><p>${copy}</p></div></details></div><details class="pdp-size-guide" open><summary>Size guide</summary><div class="pdp-size-guide-scroll"><table><thead><tr><th scope="col"><span class="pdp-sr-only">Size</span></th>${["Chest", "Waist", "Hip", "Length", "Sleeve", "Shoulder", "Neck", "Inseam"].map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead><tbody>${["XS", "S", "M", "L", "XL"].map((size) => `<tr><th scope="row">${size}</th>${Array.from({ length: 8 }, (_, i) => `<td>${80 + i * 4}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details><div class="pdp-rich"><p>${copy}</p></div><div class="pdp-actions"><button class="pdp-btn pdp-btn-cart sm-btn-secondary">Add to Cart</button><button class="pdp-btn pdp-btn-buy sm-btn-primary">Buy Now</button></div></div>
            </div></main>`,
            stacked ? "sm-pdp-stacked" : "",
          ),
        );
        const m = await page.evaluate(async () => {
          await Promise.all(
            [...document.images].map((i) => i.decode().catch(() => {})),
          );
          const rect = (el) => el.getBoundingClientRect();
          const visible = (el) => {
            if (!el) return false;
            const r = rect(el);
            return r.width > 0 && r.height > 0;
          };
          const slides = [...document.querySelectorAll(".sm-gallery-slide")];
          const track = document.querySelector(".sm-gallery-track");
          const frame = rect(document.querySelector(".sm-gallery-frame"));
          const thumbs = document.querySelector(".pdp-thumbs");
          const info = rect(document.querySelector(".pdp-info"));
          const gallery = rect(document.querySelector(".sm-gallery"));
          return {
            visibleSlides: slides.filter(visible).length,
            slideBoxes: slides.map((s) => {
              const r = rect(s);
              return {
                top: r.top,
                bottom: r.bottom,
                left: r.left,
                width: r.width,
              };
            }),
            strip: track.scrollWidth > track.clientWidth + 10,
            countVisible: visible(document.querySelector(".sm-gallery-count")),
            thumbsBox: thumbs ? rect(thumbs) : null,
            frame: {
              left: frame.left,
              right: frame.right,
              top: frame.top,
              bottom: frame.bottom,
            },
            thumbButtons: thumbs
              ? [...thumbs.querySelectorAll("button")].map((b) => {
                  const r = rect(b);
                  return { width: r.width, height: r.height };
                })
              : [],
            galleryBottom: gallery.bottom,
            galleryWidth: gallery.width,
            infoTop: info.top,
            infoWidth: info.width,
            summaries: [
              ...document.querySelectorAll(
                ".pdp-accordion-row > summary, .pdp-size-guide > summary",
              ),
            ].map((s) => rect(s).height),
            // The size guide scrolls inside its own box; the page never does.
            sizeGuideContained: (() => {
              const scroller = document.querySelector(".pdp-size-guide-scroll");
              const box = rect(scroller);
              return box.right <= innerWidth + 1 && box.left >= 0;
            })(),
          };
        });
        const measured = await measureNative(page);
        cases++;
        const problems = [];
        const desktop = width >= 860;
        if (measured.overflow) problems.push("overflow");
        if (measured.targets.length) problems.push("small targets");
        if (measured.clipped.length) problems.push("clipped text");
        if (!desktop) {
          if (!m.strip) problems.push("no strip under 860px");
          if (!m.countVisible) problems.push("no counter under 860px");
        } else {
          if (thumbs) {
            if (m.visibleSlides !== 1)
              problems.push(`${m.visibleSlides} slides visible`);
            if (
              m.thumbButtons.length !== 3 ||
              m.thumbButtons.some((b) => b.width < 24 || b.height < 24)
            )
              problems.push("thumbnails");
            if (
              mode === "thumbs-bottom" &&
              m.thumbsBox.top < m.frame.bottom - 1
            )
              problems.push("thumbnails not under the photo");
            if (mode === "thumbs-left" && m.thumbsBox.right > m.frame.left + 1)
              problems.push("thumbnails not beside the photo");
          }
          if (mode === "stacked") {
            if (m.visibleSlides !== 3)
              problems.push(`${m.visibleSlides} visible`);
            const [a, b, c] = m.slideBoxes;
            if (!(b.top >= a.bottom - 1 && c.top >= b.bottom - 1))
              problems.push("not stacked");
          }
          if (mode === "grid") {
            if (m.visibleSlides !== 3)
              problems.push(`${m.visibleSlides} visible`);
            const [a, b, c] = m.slideBoxes;
            if (
              !(
                b.top >= a.bottom - 1 &&
                Math.abs(b.top - c.top) < 2 &&
                c.left > b.left + 10 &&
                a.width > b.width * 1.5
              )
            )
              problems.push("not a two-up grid led by the first photo");
          }
          if (mode === "carousel") {
            if (!m.strip) problems.push("carousel does not scroll");
            if (!m.countVisible) problems.push("carousel has no counter");
          }
          if (m.summaries.some((h) => h < 44))
            problems.push("accordion summary under 44px");
        }
        if (!m.sizeGuideContained) problems.push("size guide escapes the page");
        if (desktop) {
          if (stacked) {
            if (m.galleryBottom > m.infoTop + 1)
              problems.push("stacked layout: info beside the gallery");
            if (width >= 1024 && (m.galleryWidth > 881 || m.infoWidth > 721))
              problems.push("stacked layout widths");
          }
        }
        if (problems.length)
          failures.push({ label, problems, ...m, ...measured });
      }
    }
    // The blog template (plan Phase 2e): the index as a grid, a list of rows
    // or a featured first post, and the article narrow, wide or with an aside
    // of related posts beside the reading column from 1024px.
    for (const index of ["grid", "list", "featured"]) {
      const label = `${width}px blog/index/${index}`;
      const card = (i) =>
        `<a href="/blogs/p${i}" class="blog-card"><div class="blog-card-image-wrapper"><img alt="" src="${image(1600, 900)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div><div class="blog-card-body"><h3 class="blog-card-title">${heading} ${i}</h3><p class="blog-card-excerpt">${copy}</p><div class="blog-card-meta"><span class="blog-card-author">Alex Morgan</span></div></div></a>`;
      await page.setContent(
        documentHtmlWith(
          blogCss,
          `<section class="blog-grid-section"><div class="blog-layout-container" data-has-sidebar="false"><div class="blog-main"><div class="blog-grid layout-${index}" id="blog-grid">${[1, 2, 3, 4, 5, 6].map(card).join("")}</div></div></div></section>`,
        ),
      );
      const measured = await measureNative(page);
      const m = await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const cards = [...document.querySelectorAll(".blog-card")].map(
          (card) => {
            const box = rect(card);
            const img = rect(card.querySelector(".blog-card-image-wrapper"));
            const body = rect(card.querySelector(".blog-card-body"));
            return {
              top: box.top,
              width: box.width,
              imageBeside: img.right <= body.left + 1 && img.height > 0,
            };
          },
        );
        return {
          cards,
          gridWidth: rect(document.querySelector(".blog-grid")).width,
        };
      });
      cases++;
      const problems = [];
      if (measured.overflow) problems.push("overflow");
      if (measured.clipped.length) problems.push("clipped text");
      if (width >= 640) {
        if (index === "list" && !m.cards.every((c) => c.imageBeside))
          problems.push("list rows do not put the picture beside the copy");
        if (index === "featured") {
          if (!m.cards[0].imageBeside || m.cards[0].width < m.gridWidth - 1)
            problems.push("featured post is not a full-width band");
          if (m.cards[1].imageBeside)
            problems.push("the posts after the featured one are not cards");
        }
        if (index === "grid" && width >= 1024) {
          const tops = m.cards.slice(0, 3).map((c) => c.top);
          if (Math.max(...tops) - Math.min(...tops) > 1)
            problems.push("the grid is not three across");
        }
      } else if (m.cards.some((c) => c.imageBeside)) {
        problems.push("a phone card is not stacked");
      }
      if (problems.length)
        failures.push({ label, problems, ...m, ...measured });
    }
    for (const article of ["narrow", "wide", "sidebar"]) {
      const label = `${width}px blog/article/${article}`;
      await page.setContent(
        documentHtmlWith(
          blogCss,
          `<section class="blog-detail-page-section article-${article}"><div class="blog-detail-content-container">${article === "sidebar" ? `<aside class="blog-article-aside" aria-label="Keep reading"><p class="blog-article-aside-kicker">Keep reading</p><ul class="blog-article-aside-list">${[1, 2, 3].map((i) => `<li><a href="/blogs/p${i}">${heading} ${i}</a></li>`).join("")}</ul></aside>` : ""}<div class="blog-detail-cover"><img alt="" src="${image(1600, 900)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div><div class="blog-detail-header"><h1 class="blog-detail-title">${heading}</h1></div><article class="blog-prose"><p>${copy.repeat(6)}</p><h2>${heading}</h2><p>${copy.repeat(4)}</p></article></div></section>`,
        ),
      );
      const measured = await measureNative(page);
      const m = await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const container = rect(
          document.querySelector(".blog-detail-content-container"),
        );
        const prose = rect(document.querySelector(".blog-prose"));
        const aside = document.querySelector(".blog-article-aside");
        return {
          containerWidth: container.width,
          proseWidth: prose.width,
          asideBeside: aside ? rect(aside).left >= prose.right - 1 : null,
          asideAbove: aside ? rect(aside).bottom <= prose.top + 1 : null,
          asideLinks: aside
            ? [...aside.querySelectorAll("a")].map((a) => rect(a).height)
            : [],
        };
      });
      cases++;
      const problems = [];
      if (measured.overflow) problems.push("overflow");
      if (measured.clipped.length) problems.push("clipped text");
      const cap = article === "narrow" ? 720 : article === "wide" ? 960 : 1060;
      if (m.containerWidth > cap + 1)
        problems.push("container wider than its cap");
      if (article === "narrow" && width >= 1024 && m.proseWidth > 721)
        problems.push("narrow column wider than 720px");
      if (article === "wide" && width >= 1024 && m.proseWidth < 900)
        problems.push("wide column not wider than the reading column");
      if (article === "sidebar") {
        if (m.asideLinks.some((h) => h < 40))
          problems.push("aside links under 40px");
        if (width >= 1024 ? !m.asideBeside : !m.asideAbove)
          problems.push(
            width >= 1024
              ? "aside not beside the column"
              : "aside not above the column",
          );
      }
      if (problems.length)
        failures.push({ label, problems, ...m, ...measured });
    }
    // The account template: tabs above a page, or a navigation column beside
    // it from 1024px, and a scheme over the whole page.
    for (const layout of ["tabs", "sidebar"]) {
      const label = `${width}px account/${layout}/inverse`;
      await page.setContent(
        documentHtmlWith(
          accountCss +
            "\n.sm-account-page{padding:140px 24px 80px;background:var(--sm-cream);color:var(--sm-ink)}",
          `<div class="sm-account layout-${layout} sm-scheme sm-scheme-inverse"><nav class="sm-account-nav" aria-label="Account"><a href="/profile">Profile</a><a href="/orders" aria-current="page">Orders</a><a href="/notifications">Notifications</a></nav><div class="sm-account-page"><h1>My orders</h1><p>${copy}</p></div></div>`,
        ),
      );
      const measured = await measureNative(page);
      const m = await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const shell = document.querySelector(".sm-account");
        const nav = rect(document.querySelector(".sm-account-nav"));
        const pageBox = rect(document.querySelector(".sm-account-page"));
        const heading = rect(document.querySelector("h1"));
        return {
          links: [...document.querySelectorAll(".sm-account-nav a")].map(
            (a) => rect(a).height,
          ),
          navBeside: nav.right <= pageBox.left + 1,
          navAbove: nav.bottom <= heading.top + 1,
          gapUnderNav: heading.top - nav.bottom,
          background: getComputedStyle(shell).backgroundColor,
          color: getComputedStyle(document.querySelector("h1")).color,
        };
      });
      cases++;
      const problems = [];
      if (measured.overflow) problems.push("overflow");
      if (measured.clipped.length) problems.push("clipped text");
      if (m.links.some((h) => h < 40))
        problems.push("account links under 40px");
      if (m.background !== "rgb(33, 28, 37)")
        problems.push(`scheme background not applied: ${m.background}`);
      if (m.color !== "rgb(250, 248, 245)")
        problems.push(`scheme ink not applied: ${m.color}`);
      if (layout === "sidebar" && width >= 1024) {
        if (!m.navBeside)
          problems.push("sidebar navigation not beside the page");
      } else {
        if (!m.navAbove) problems.push("tabs not above the page");
        if (m.gapUnderNav > 60)
          problems.push(
            `page keeps its full offset under the tabs (${m.gapUnderNav}px)`,
          );
      }
      if (problems.length)
        failures.push({ label, problems, ...m, ...measured });
    }
    // The collection template: a row of filter popovers above the grid on
    // desktop (hidden under 1024px, where the Filter button's drawer serves),
    // an open popover floating over the grid rather than pushing it, a
    // promotional tile among the cards, and numbered pages whose buttons are
    // 40px targets that never overflow a phone.
    {
      const label = `${width}px collection/top-bar/paged/tile`;
      const card = (i) =>
        `<a class="shop-card" href="/shop"><div class="shop-card-img"><img class="shop-card-img-el" alt="" src="${image(1200, 1600)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div><div class="shop-card-body"><h2 class="shop-card-name">Linen shirt ${i}</h2><div class="shop-card-price"><span class="shop-card-sell">₹1,800</span></div></div></a>`;
      const group = (title) =>
        `<details class="shop-filter-group"><summary><span>${title}</span></summary><div class="shop-filter-group-body"><ul class="shop-filter-list">${["Small", "Medium", "Large"].map((v) => `<li><label class="shop-filter-check"><input type="checkbox"><span>${v}</span><span class="shop-filter-muted">(3)</span></label></li>`).join("")}</ul></div></details>`;
      await page.setContent(
        documentHtmlShop(
          `<div class="shop-listing"><div class="shop-layout"><div class="shop-results"><div class="shop-topbar-filters"><div class="shop-facets">${["Availability", "Size", "Colour", "Price"].map(group).join("")}</div></div><div class="shop-grid">${card(1)}${card(2)}<a class="shop-promo-tile theme-dark" href="/collections/summer" style="background:#2a211f"><div class="shop-promo-tile-copy"><h2>${heading}</h2><p>${copy}</p><span class="shop-promo-tile-cta">See the edit</span></div></a>${card(3)}${card(4)}${card(5)}</div><nav class="shop-pages" aria-label="Pages"><p class="shop-pages-count">Showing 1–24 of 160 products</p><button disabled>Previous</button><button aria-current="page" aria-label="Page 1">1</button><button aria-label="Page 2">2</button><button aria-label="Page 3">3</button><button aria-label="Page 4">4</button><span class="shop-pages-gap" aria-hidden="true">…</span><button aria-label="Page 7">7</button><button>Next</button></nav></div></div></div>`,
        ),
      );
      const measured = await measureNative(page);
      const before = await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const bar = document.querySelector(".shop-topbar-filters");
        const barBox = rect(bar);
        // Links and buttons only: a filter checkbox is 20px by design and
        // its 40px label is the target (the acceptance probe's own rule),
        // and a closed popover's inputs still report a box in Chromium.
        const smallTargets = [...document.querySelectorAll("a,button")]
          .map((el) => rect(el))
          .filter(
            (r) => r.width && r.height && (r.width < 24 || r.height < 24),
          ).length;
        return {
          smallTargets,
          barVisible: barBox.width > 0 && barBox.height > 0,
          summaryTops: [...bar.querySelectorAll("summary")].map(
            (s) => rect(s).top,
          ),
          gridTop: rect(document.querySelector(".shop-grid")).top,
          tile: rect(document.querySelector(".shop-promo-tile")).height,
          pageButtons: [...document.querySelectorAll(".shop-pages button")].map(
            (b) => {
              const r = rect(b);
              return { width: r.width, height: r.height, right: r.right };
            },
          ),
          current: getComputedStyle(
            document.querySelector('.shop-pages [aria-current="page"]'),
          ).backgroundColor,
        };
      });
      await page.evaluate(() => {
        const first = document.querySelector(".shop-topbar-filters details");
        if (first) first.open = true;
      });
      const after = await page.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const body = document.querySelector(
          ".shop-topbar-filters details[open] > .shop-filter-group-body",
        );
        const box = body ? rect(body) : null;
        return {
          gridTop: rect(document.querySelector(".shop-grid")).top,
          bodyVisible: !!box && box.width > 0 && box.height > 0,
          bodyWithin: !!box && box.right <= innerWidth && box.left >= 0,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      cases++;
      const problems = [];
      if (measured.overflow || after.overflow) problems.push("overflow");
      if (before.smallTargets) problems.push("small targets");
      if (measured.clipped.length) problems.push("clipped text");
      if (before.pageButtons.some((b) => b.width < 40 || b.height < 40))
        problems.push("page buttons under 40px");
      if (before.pageButtons.some((b) => b.right > width))
        problems.push("page buttons overflow");
      if (before.current === "rgba(0, 0, 0, 0)")
        problems.push("current page not marked");
      if (before.tile < 240) problems.push("promo tile too short");
      if (width >= 1024) {
        if (!before.barVisible) problems.push("filter bar hidden on desktop");
        if (
          Math.max(...before.summaryTops) - Math.min(...before.summaryTops) >
          2
        )
          problems.push("filter pills wrap");
        if (!after.bodyVisible || !after.bodyWithin)
          problems.push("open popover not shown within the viewport");
        if (Math.abs(after.gridTop - before.gridTop) > 1)
          problems.push("open popover pushes the grid");
      } else if (before.barVisible) {
        problems.push("filter bar shown under 1024px");
      }
      if (problems.length)
        failures.push({ label, problems, before, after, ...measured });
    }
    // Maximum supported slide count, including active and inactive controls.
    await page.setContent(
      documentHtml(`<section class="home-section"><div class="home-carousel">
      <div class="home-carousel-dots">${Array.from({ length: 8 }, (_, i) => `<button class="home-carousel-dot ${i === 0 ? "is-active" : ""}" aria-label="Go to slide ${i + 1}"></button>`).join("")}</div>
      </div></section>`),
    );
    const controls = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((button) => {
        const r = button.getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          left: r.left,
          right: r.right,
        };
      }),
    );
    cases++;
    if (
      controls.some(
        (r) => r.width < 24 || r.height < 24 || r.left < 0 || r.right > width,
      )
    )
      failures.push({ label: `${width}px carousel controls`, controls });
    await page.locator("button").first().focus();
    if (
      await page
        .locator("button")
        .first()
        .evaluate((button) => getComputedStyle(button).outlineStyle === "none")
    )
      failures.push({ label: `${width}px carousel focus indicator` });
  }
  await page.setViewportSize({ width: 360, height: 800 });
  await page.setContent(
    documentHtml(
      '<button style="width:9px;height:9px;padding:0">x</button><div style="width:2000px">overflow</div><h2 style="width:20px;white-space:nowrap">Clipped heading</h2><div style="position:relative;width:300px;height:40px"><img alt="Crop" src="' +
        image(900, 1600) +
        '" style="position:absolute;width:100%;height:100%;object-fit:cover"></div>',
    ),
  );
  const broken = await measureNative(page);
  await page.addScriptTag({ content: axe });
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "Contrast negative control";
    p.style.cssText =
      "position:fixed;top:0;left:0;color:#aaaaaa;background:#ffffff;font-size:16px;z-index:100";
    document.body.append(p);
  });
  const badContrast = await page.evaluate(
    async () =>
      (
        await window.axe.run(document, {
          runOnly: { type: "rule", values: ["color-contrast"] },
        })
      ).violations.length,
  );
  if (
    !broken.overflow ||
    !broken.targets.length ||
    !broken.crop.length ||
    !broken.clipped.length ||
    !badContrast
  )
    failures.push({ label: "negative controls were not detected", ...broken });
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    { script: fileURLToPath(import.meta.url), cases, failures },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
