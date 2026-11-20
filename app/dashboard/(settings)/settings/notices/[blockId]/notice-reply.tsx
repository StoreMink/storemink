"use client";

import {
  startTransition,
  useEffect,
  useId,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  markStoreNoticeSeenAction,
  replyToStoreNoticeAction,
} from "@/app/actions/store-notice-actions";
import { NOTICE_REPLY, NOTICE_REPLY_MAX } from "@/lib/moderation/copy";

/**
 * The store's reply on a notice from StoreMink (takedown design 7.1): the
 * reply box, the review tick and Send reply. The server re-checks everything
 * (Settings manage, the notice, the length, a lifted block); the checks here
 * only save a round trip.
 */
export function NoticeReply({
  blockId,
  tickLabel,
}: {
  blockId: string;
  /** "I have fixed this. Please review it again." or "Please show it again." */
  tickLabel: string;
}) {
  const router = useRouter();
  const ids = useId();
  const [body, setBody] = useState("");
  const [asksReview, setAsksReview] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) {
      setError(NOTICE_REPLY.errors.empty);
      return;
    }
    if (text.length > NOTICE_REPLY_MAX) {
      setError(NOTICE_REPLY.errors.tooLong);
      return;
    }
    setError("");
    start(async () => {
      try {
        const result = await replyToStoreNoticeAction(
          blockId,
          text,
          asksReview,
        );
        if (!result.ok) {
          setError(result.error ?? NOTICE_REPLY.failed);
          return;
        }
        setBody("");
        setAsksReview(false);
        toast.success(NOTICE_REPLY.sent);
        router.refresh();
      } catch {
        setError(NOTICE_REPLY.failed);
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <label
        htmlFor={`${ids}-body`}
        className="text-sm font-semibold text-[var(--dash-text)]"
      >
        {NOTICE_REPLY.label}
      </label>
      <textarea
        id={`${ids}-body`}
        className="dash-input w-full"
        rows={5}
        value={body}
        placeholder={NOTICE_REPLY.placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${ids}-error` : undefined}
        onChange={(event) => setBody(event.target.value)}
        disabled={pending}
      />
      <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--dash-text)]">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={asksReview}
          onChange={(event) => setAsksReview(event.target.checked)}
          disabled={pending}
        />
        {tickLabel}
      </label>
      {error && (
        <p
          id={`${ids}-error`}
          role="alert"
          className="text-sm text-[var(--dash-red)]"
        >
          {error}
        </p>
      )}
      <div>
        <button
          type="submit"
          className="dash-btn dash-btn-primary pointer-coarse:min-h-11"
          disabled={pending}
        >
          {NOTICE_REPLY.button}
        </button>
      </div>
    </form>
  );
}

/**
 * Marks the notice seen once it is on screen: the block, StoreMink's
 * messages on it and the viewer's bell notifications about it. Quiet: a
 * failure leaves the notice unseen, which only keeps the banner a little
 * longer.
 */
export function NoticeSeen({ blockId }: { blockId: string }) {
  useEffect(() => {
    startTransition(async () => {
      try {
        await markStoreNoticeSeenAction(blockId);
      } catch {
        // Seen is a courtesy; the notice itself is already on screen.
      }
    });
  }, [blockId]);
  return null;
}
