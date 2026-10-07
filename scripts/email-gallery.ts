// Render every email StoreMink sends into .email-gallery/ and open the index.
//
//   npm run email:gallery
//
// The list is lib/email/email-samples.ts, the same one the no-long-dash CI
// guard reads, so a mailer that is missing here is missing from the guard too.
// Output is gitignored: regenerate it whenever the design changes.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderEmailSamples, SAMPLE_LOGOS } from "@/lib/email/email-samples";

const outDir = join(process.cwd(), ".email-gallery");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Stand-in logos in three shapes, for the "Store logo sizing" samples.
const logo = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
writeFileSync(
  join(outDir, SAMPLE_LOGOS.wide),
  logo(
    800,
    200,
    `<rect width="800" height="200" rx="24" fill="#2f6b3a"/><text x="400" y="128" font-family="Georgia" font-size="96" fill="#fff" text-anchor="middle">Acme Juice</text>`,
  ),
);
writeFileSync(
  join(outDir, SAMPLE_LOGOS.square),
  logo(
    600,
    600,
    `<rect width="600" height="600" rx="120" fill="#2f6b3a"/><text x="300" y="380" font-family="Georgia" font-size="260" fill="#fff" text-anchor="middle">AJ</text>`,
  ),
);
writeFileSync(
  join(outDir, SAMPLE_LOGOS.tall),
  logo(
    300,
    600,
    `<rect width="300" height="600" rx="40" fill="#2f6b3a"/><text x="150" y="330" font-family="Georgia" font-size="140" fill="#fff" text-anchor="middle">AJ</text>`,
  ),
);

const samples = renderEmailSamples();
const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const groups = new Map<string, typeof samples>();
for (const sample of samples) {
  writeFileSync(join(outDir, `${sample.id}.html`), sample.html);
  groups.set(sample.group, [...(groups.get(sample.group) ?? []), sample]);
}

const nav = [...groups.entries()]
  .map(
    ([group, list]) =>
      `<h2>${escape(group)}</h2><ul>${list
        .map(
          (sample) =>
            `<li><a href="${sample.id}.html" target="mail" title="${escape(sample.subject)}">${escape(sample.label)}</a></li>`,
        )
        .join("")}</ul>`,
  )
  .join("");

writeFileSync(
  join(outDir, "index.html"),
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>StoreMink emails</title>
<style>
  body { margin: 0; display: flex; height: 100vh; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #141413; background: #fff; }
  nav { width: 300px; overflow: auto; padding: 20px; border-right: 1px solid #e6e3da; background: #faf9f5; box-sizing: border-box; }
  h1 { font: 400 24px Georgia, serif; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: #6f6d66; }
  h2 { font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: #6f6d66; margin: 20px 0 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  a { display: block; padding: 4px 0; color: #141413; text-decoration: none; }
  a:hover { text-decoration: underline; }
  iframe { flex: 1; border: 0; height: 100vh; }
</style></head><body>
<nav><h1>StoreMink emails</h1><p>${samples.length} messages</p>${nav}</nav>
<iframe name="mail" src="${samples[0]?.id ?? ""}.html"></iframe>
</body></html>`,
);

console.log(
  `Wrote ${samples.length} emails to ${outDir}. Open .email-gallery/index.html in a browser.`,
);
