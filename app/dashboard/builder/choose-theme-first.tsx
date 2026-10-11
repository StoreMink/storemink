import Link from "next/link";
import { LayoutTemplate } from "lucide-react";

// Shown at /dashboard/builder instead of the editor while the store has no
// theme (lib/store/launch-state.ts isThemePending). It renders in the normal
// dashboard shell, not the builder's full-screen overlay, so the sidebar stays
// one click away.
export function ChooseThemeFirst({ canChoose }: { canChoose: boolean }) {
  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <h1>Website Builder</h1>
        <p>Edit your storefront&rsquo;s pages, header and footer.</p>
      </header>

      <section className="dash-card mt-6 max-w-2xl">
        <div className="dash-card-body">
          <div className="dash-empty">
            <div className="dash-empty-icon" aria-hidden="true">
              <LayoutTemplate size={20} />
            </div>
            <h2 className="dash-empty-title">Choose a theme first</h2>
            <p className="dash-empty-text">
              The Website Builder edits the pages your theme gives your store,
              so it opens once you&rsquo;ve chosen one. Until then your
              storefront shows a store-in-progress page.
            </p>
            {canChoose ? (
              <Link
                href="/dashboard/storefront"
                className="dash-btn dash-btn-primary"
              >
                Choose a theme
              </Link>
            ) : (
              // A link to a page they can't open would only bounce them back.
              <p className="dash-empty-text">
                Ask the store owner to choose one on the Storefront page.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
