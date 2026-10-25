import { diffThemePackages, type ThemeDiff } from "@/lib/theme-studio/diff";
import { getThemeStudioVersionPackages } from "@/lib/theme-studio/repository";
import { plainText } from "../studio-ui";
import { designLabel } from "../studio-words";
import type { StudioTabProps } from "./tab-types";
import { readStudioProject, readStudioShownAncestor } from "./tab-reads";

// ---------------------------------------------------------------------------
// The Changes tab (wave TS-2, builder 2C): what changed in the design shown
// against the design it was made from: today's compare view, moved here
// (the old /compare address redirects to this tab).
//
// ★ COMPARED WITH A DESIGN THE OPERATOR CAN SEE. The automatic fixes make
// hidden drafts in between, so the tab walks back to the nearest earlier
// design that is in the Design list and says how many fixes lie between
// (tab-reads.ts readStudioShownAncestor). The first design of a theme has
// nothing to compare with.
//
// An async server component: only the theme page renders it, after its
// superadmin gate, and only while this tab is open.
// ---------------------------------------------------------------------------

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="studio-muted text-xs font-medium">{title}</p>
      <ul className="mt-1 list-disc pl-5 text-sm">
        {items.map((item) => (
          <li key={item}>{plainText(item)}</li>
        ))}
      </ul>
    </div>
  );
}

const PAGE_CHANGE: Record<string, string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
};

/** What two designs' theme files differ in, for an operator: the design
 * settings that moved, the pages, the sample catalogue, the navigation and
 * the capability gaps (diff.ts). */
export function ChangesView({ diff }: { diff: ThemeDiff }) {
  if (diff.identical) {
    return (
      <p className="studio-muted rounded-[var(--dash-radius)] border border-[var(--dash-border)] bg-[var(--dash-surface)] px-4 py-6 text-center text-sm">
        These two designs make the same theme.
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      {diff.tokens.length > 0 ? (
        <section className="dash-card" aria-labelledby="studio-changes-tokens">
          <div className="dash-card-header">
            <h2 id="studio-changes-tokens" className="dash-card-title">
              Design settings ({diff.tokens.length})
            </h2>
          </div>
          <div className="dash-card-body">
            <table className="w-full text-left text-sm">
              <thead className="studio-muted text-xs">
                <tr>
                  <th className="py-1 pr-3 font-medium">Setting</th>
                  <th className="py-1 pr-3 font-medium">Before</th>
                  <th className="py-1 font-medium">After</th>
                </tr>
              </thead>
              <tbody>
                {diff.tokens.map((t) => (
                  <tr
                    key={`${t.group}.${t.key}`}
                    className="border-t border-[var(--dash-border)]"
                  >
                    <td className="studio-code py-1.5 pr-3">
                      {t.group}.{t.key}
                    </td>
                    {[t.before, t.after].map((value, i) => (
                      <td key={i} className="py-1.5 pr-3">
                        <span className="inline-flex items-center gap-2">
                          {value && /^#[0-9a-f]{3,8}$/i.test(value) ? (
                            <span
                              aria-hidden="true"
                              className="inline-block h-3.5 w-3.5 rounded border border-[var(--dash-border-strong)]"
                              style={{ background: value }}
                            />
                          ) : null}
                          <span className="studio-code break-all">
                            {value ?? "none"}
                          </span>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {diff.pages.length > 0 ? (
        <section className="dash-card" aria-labelledby="studio-changes-pages">
          <div className="dash-card-header">
            <h2 id="studio-changes-pages" className="dash-card-title">
              Pages ({diff.pages.length})
            </h2>
          </div>
          <div className="dash-card-body">
            <ul className="grid gap-3">
              {diff.pages.map((page) => (
                <li
                  key={page.slug}
                  className="rounded-[var(--dash-radius-sm)] bg-[var(--dash-surface-2)] p-3"
                >
                  <p className="text-sm font-medium">
                    {plainText(page.title)}{" "}
                    <span className="studio-code">/{page.slug}</span>{" "}
                    <span className="studio-muted text-xs">
                      {PAGE_CHANGE[page.change] ?? page.change}
                    </span>
                  </p>
                  <div className="mt-1 grid gap-2 text-xs sm:grid-cols-2">
                    <p>
                      Before:{" "}
                      {page.before.map(plainText).join(", then ") || "none"}
                    </p>
                    <p>
                      After:{" "}
                      {page.after.map(plainText).join(", then ") || "none"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="dash-card" aria-labelledby="studio-changes-rest">
        <div className="dash-card-header">
          <h2 id="studio-changes-rest" className="dash-card-title">
            Sample catalogue, navigation and gaps
          </h2>
        </div>
        <div className="dash-card-body grid gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-2">
            <List title="Products added" items={diff.products.added} />
            <List title="Products removed" items={diff.products.removed} />
            <List title="Products changed" items={diff.products.changed} />
            <List title="Categories added" items={diff.categories.added} />
            <List title="Categories removed" items={diff.categories.removed} />
            <List title="Categories changed" items={diff.categories.changed} />
            {!diff.products.added.length &&
            !diff.products.removed.length &&
            !diff.products.changed.length &&
            !diff.categories.added.length &&
            !diff.categories.removed.length &&
            !diff.categories.changed.length ? (
              <p className="studio-muted text-sm">
                The sample catalogue is the same.
              </p>
            ) : null}
          </div>
          <div className="grid content-start gap-2">
            <p className="text-sm">
              Navigation {diff.navigationChanged ? "changed" : "is the same"}.
            </p>
            <List title="Capability gaps added" items={diff.gaps.added} />
            <List title="Capability gaps cleared" items={diff.gaps.removed} />
          </div>
        </div>
      </section>
    </div>
  );
}

export async function ChangesTab({ projectId, versionId }: StudioTabProps) {
  if (!versionId) {
    return (
      <p className="studio-muted">
        There is no design yet, so nothing has changed.
      </p>
    );
  }
  const project = await readStudioProject(projectId);
  const version = project?.versions.find((v) => v.id === versionId) ?? null;
  if (!project || !version) {
    return (
      <p className="studio-muted">
        Choose a design in the list at the top to see what changed in it.
      </p>
    );
  }
  const design = designLabel(version.versionNumber);
  if (!version.hasPackage) {
    return (
      <p className="studio-muted">
        {design} has no theme file, so there is nothing to compare.
      </p>
    );
  }
  const ancestor = await readStudioShownAncestor(projectId, version.id);
  if (!ancestor) {
    return (
      <p className="studio-muted">
        {design} is where this theme started, so there is nothing to compare it
        with.
      </p>
    );
  }
  const before = designLabel(ancestor.versionNumber);
  const packages = await getThemeStudioVersionPackages(projectId, [
    ancestor.id,
    version.id,
  ]);
  const from = packages.find((p) => p.id === ancestor.id);
  const to = packages.find((p) => p.id === version.id);
  return (
    <div className="grid max-w-5xl gap-4">
      <div className="grid gap-1">
        <h2 className="text-base font-semibold">
          {design}, compared with {before}
        </h2>
        <p className="studio-muted text-sm">
          {version.origin === "asset_edit"
            ? `${design} was made by replacing pictures in ${before}.`
            : `${design} was made from ${before}.`}
          {ancestor.between > 0
            ? ` Theme Studio's automatic fixes made ${ancestor.between} draft${ancestor.between === 1 ? "" : "s"} in between, which are not designs of their own.`
            : ""}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { label: before, summary: from?.summary ?? "" },
          { label: design, summary: to?.summary ?? "" },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] bg-[var(--dash-surface)] p-3 text-sm"
          >
            <p className="font-medium">{item.label}</p>
            {item.summary ? (
              <p className="studio-muted mt-1">{plainText(item.summary)}</p>
            ) : null}
          </div>
        ))}
      </div>
      {from?.package && to?.package ? (
        <ChangesView diff={diffThemePackages(from.package, to.package)} />
      ) : (
        <p className="studio-notice" data-tone="warning">
          One of these designs has a theme file that can no longer be read, so
          they can&apos;t be compared.
        </p>
      )}
    </div>
  );
}
