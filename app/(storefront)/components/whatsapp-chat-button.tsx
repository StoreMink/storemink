// The storefront's "chat on WhatsApp" button (docs/whatsapp-commerce-plan.md
// §6B). A plain link to Meta's click-to-chat scheme, fixed bottom-right; the
// server decides whether to render it (lib/whatsapp/storefront.ts), so a page
// never shows a button for a number that cannot answer. No JavaScript: it is
// an anchor, which is what makes it work before hydration and under reduced
// motion alike.

export function WhatsAppChatButton({ href }: { href: string }) {
  return (
    <a
      className="sm-wa-chat"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with us on WhatsApp"
      data-sm="whatsapp-chat"
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 7L3 29l6.4-2c2 1.1 4.3 1.7 6.6 1.7 7.2 0 13-5.7 13-12.8S23.2 3 16 3zm0 23.4c-2 0-4-.6-5.7-1.6l-.4-.2-3.8 1.2 1.2-3.7-.3-.4a10.3 10.3 0 0 1-1.7-5.9C5.3 10 10.1 5.4 16 5.4s10.7 4.7 10.7 10.4-4.8 10.6-10.7 10.6zm5.9-7.8c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7.1-.3-.2-1.3-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.6l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.1 1.1-1.1 2.7s1.2 3.1 1.3 3.3c.2.2 2.3 3.5 5.6 4.9.8.3 1.4.5 1.9.7.8.2 1.5.2 2 .1.6-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z"
        />
      </svg>
      <span className="sm-wa-chat-label">Chat with us</span>
    </a>
  );
}
