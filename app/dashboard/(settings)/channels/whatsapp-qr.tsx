"use client";

// The QR a merchant prints for the counter or packaging: scanning it opens a
// chat with the store's WhatsApp number (lib/whatsapp/chat-link.ts). Drawn
// client-side with the QR writer @zxing/browser already ships for the camera
// scanner — the collection-code QR's precedent — so it costs no new package
// and no image to host. The link beneath it is the primary; the QR is the
// convenience, and a failed draw leaves the link.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export function WhatsAppQr({ href }: { href: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const el = holder.current;
    if (!el) return;
    void (async () => {
      try {
        const { BrowserQRCodeSvgWriter } = await import("@zxing/browser");
        if (cancelled || !holder.current) return;
        holder.current.replaceChildren();
        new BrowserQRCodeSvgWriter().writeToDom(holder.current, href, 160, 160);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [href]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it yourself.");
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      {!failed && (
        <div
          ref={holder}
          aria-hidden="true"
          className="shrink-0 rounded-md border border-[rgba(17,24,39,0.08)] bg-white p-2"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="break-all font-mono text-[12px] text-[#111827]">{href}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded-md border border-[rgba(17,24,39,0.16)] px-3 py-1.5 text-xs font-medium text-[#111827] hover:bg-[#f9fafb]"
          >
            Copy link
          </button>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-[rgba(17,24,39,0.16)] px-3 py-1.5 text-xs font-medium text-[#111827] hover:bg-[#f9fafb]"
          >
            Try it
          </a>
        </div>
      </div>
    </div>
  );
}
