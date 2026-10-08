"use client";

import { Component, type ReactNode } from "react";

// Per-section error boundary for storefront pages. A section whose stored
// config no longer matches what its component expects (an older shape, a
// malformed row, a renderer regression) throws during render; without this
// the nearest boundary is the route's error.tsx and the whole page is lost.
// Rendering nothing is the right fallback for a shop page: a missing band is
// invisible to a customer, a broken page is not. The id/type are logged so
// the merchant's builder (and our logs) can point at the offending section.
//
// A class because React only exposes error boundaries through
// getDerivedStateFromError/componentDidCatch.
export class SectionErrorBoundary extends Component<
  { sectionId: string; sectionType: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(
      `storefront: section ${this.props.sectionType} (${this.props.sectionId}) failed to render`,
      error,
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
