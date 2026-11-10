"use client";

import { useEffect } from "react";
import { useChat } from "./chat-context";

/**
 * Offers the current page's own question to the top-bar "Ask Mink AI" bar
 * and the panel's empty state. Renders nothing: it sets the suggestion on
 * mount and when it changes, and clears it on unmount, so a page that
 * already knows a better question (the go-live card's open task) needs no
 * extra read.
 */
export function MinkPageSuggestion({
  label,
  prompt,
}: {
  label: string;
  prompt: string;
}) {
  const { setPageSuggestion } = useChat();
  useEffect(() => {
    setPageSuggestion({ label, prompt });
  }, [label, prompt, setPageSuggestion]);
  useEffect(() => () => setPageSuggestion(null), [setPageSuggestion]);
  return null;
}
