"use client";

import { useEffect } from "react";
import Link from "next/link";
import "./error.css";

// In-store error boundary — the store resolved and its layout (Header/Footer,
// theme tokens) rendered, but a page inside it threw. Renders INSIDE the
// storefront layout, so like not-found.tsx it carries no palette of its own:
// everything resolves through the --sm-* tokens on .storefront-root.
//
// Section-level failures never reach here (SectionErrorBoundary swallows
// them); this catches the rest — a data query, a product route, a theme
// variant component — so a customer sees the store's chrome and a way back
// rather than Next's blank default.
export default function StorefrontError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // Production strips the message; the digest is what matches server logs.
    console.error("storefront: page failed to render", error.digest ?? error);
  }, [error]);

  return (
    <main className="sferr" role="alert">
      <p className="sferr-tag">Something went wrong</p>
      <h1 className="sferr-title">This page couldn&rsquo;t be shown</h1>
      <p className="sferr-lede">
        The rest of the store is working. Try the page again, or carry on
        browsing from the home page.
      </p>
      <div className="sferr-actions">
        <button className="sferr-retry" type="button" onClick={unstable_retry}>
          Try again
        </button>
        <Link className="sferr-link" href="/">
          Back to home
        </Link>
      </div>
      {error.digest ? (
        <p className="sferr-ref">Reference: {error.digest}</p>
      ) : null}
    </main>
  );
}
