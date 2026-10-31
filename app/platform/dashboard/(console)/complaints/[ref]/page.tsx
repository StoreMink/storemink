import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  getComplaint,
  type ComplaintPage,
} from "@/lib/moderation/console-read";
import { isEmailContact } from "@/lib/moderation/complaints";
import { complaintKindLabel, parseComplaintRef } from "@/lib/moderation/kinds";
import { deadlineLabel, deadlineStages } from "@/lib/moderation/deadlines";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { requireOperator } from "../../require-operator";
import {
  BlocksTable,
  CHANNEL_LABEL,
  EMPTY_TEXT,
  EmptyState,
  STATUS_TONE,
  complaintStatusText,
  eventLine,
  istDate,
  istDateTime,
  stageDue,
  stageStatus,
} from "../complaints-console";
import { ComplaintActions } from "./complaint-actions";

// ---------------------------------------------------------------------------
// One complaint (takedown design 6.4): its deadlines, its details, what can
// be done next, its blocks and its history.
//
// ★ GATED ON ITS OWN with `requireOperator()` (CODEBASE §39): this page shows
// a complainant's name and contact, read under `withService`.
//
// ★ AN ADDRESS OPENS ONLY AS A WEB ADDRESS. The addresses are typed from a
// complaint, so only http and https ones become links (in a new tab, with no
// opener); anything else is shown as text.
// ---------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const { ref } = await params;
  const shown = parseComplaintRef(ref) !== null;
  return {
    title: `${shown ? `Complaint ${ref.toUpperCase()}` : "Complaint"} · StoreMink Admin`,
  };
}

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-[var(--dash-text-2)]">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-[var(--dash-text)]">
        {children}
      </dd>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="dash-card">
      <div className="dash-card-header">
        <h2 className="dash-card-title">{title}</h2>
      </div>
      {children}
    </section>
  );
}

const dash = <span className="text-[var(--dash-text-2)]">-</span>;

export default async function ComplaintPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  await requireOperator();
  const { ref } = await params;
  const now = new Date();

  let page: ComplaintPage | null;
  try {
    page = await getComplaint(ref, { now });
  } catch (err) {
    logError("complaints console: complaint read failed", loggableError(err));
    return (
      <div className="dash-page-enter">
        <p role="alert" className="text-sm text-[var(--dash-text)]">
          This complaint could not be read just now. Refresh the page to try
          again.
        </p>
      </div>
    );
  }
  if (!page) notFound();

  const { complaint: c, blocks, events } = page;
  const email = isEmailContact(c.complainantContact)
    ? c.complainantContact.trim()
    : null;

  return (
    <div className="dash-page-enter space-y-5">
      <div>
        <Link
          href="/dashboard/complaints"
          className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--dash-text-2)] hover:text-[var(--dash-text)] pointer-coarse:min-h-11"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
          Complaints
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-[var(--dash-text)]">
            Complaint {c.ref}
          </h1>
          <span className="dash-badge dash-badge-grey">
            {complaintKindLabel(c.kind)}
          </span>
          <span className={`dash-badge ${STATUS_TONE[c.status]}`}>
            {complaintStatusText(c)}
          </span>
        </div>
      </div>

      <ComplaintActions
        complaintId={c.id}
        reference={c.ref}
        kind={c.kind}
        email={email}
        acknowledged={c.acknowledgedAt !== null}
        actioned={c.actionedAt !== null}
        resolved={c.resolvedAt !== null}
        erased={c.erasedAt !== null}
      />

      <Card title="Deadlines">
        <dl className="divide-y divide-[var(--dash-border)] px-5 py-2">
          {deadlineStages(c.kind).map((stage) => {
            const status = stageStatus(c, stage, now);
            return (
              <Fact
                key={stage}
                label={`${deadlineLabel(c.kind, stage)} ${istDateTime(stageDue(c, stage), now)}`}
              >
                <span
                  className={
                    status.overdue
                      ? "font-medium text-[var(--dash-red)]"
                      : undefined
                  }
                >
                  {status.text}
                </span>
              </Fact>
            );
          })}
        </dl>
      </Card>

      <Card title="Details">
        <dl className="divide-y divide-[var(--dash-border)] px-5 py-2">
          <Fact label="Received">{istDateTime(c.receivedAt, now)}</Fact>
          <Fact label="How it reached us">
            {CHANNEL_LABEL[c.channel] ?? c.channel}
          </Fact>
          {c.erasedAt ? (
            <p className="py-3 text-sm text-[var(--dash-text)]">
              The complainant&apos;s details were erased on{" "}
              {istDate(c.erasedAt)}, 3 years after it was resolved.
            </p>
          ) : (
            <>
              <Fact label="From">{c.complainantName || dash}</Fact>
              <Fact label="Contact">{c.complainantContact || dash}</Fact>
              <Fact label="Acting for">{c.actingFor || dash}</Fact>
              <Fact label="Reference">{c.authorityRef || dash}</Fact>
            </>
          )}
          <Fact label="Store">
            {c.store ? (
              <Link
                href={`/dashboard/stores/${c.store.id}`}
                className="hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                {c.storeLabel || c.store.name}
              </Link>
            ) : (
              c.storeLabel || dash
            )}
          </Fact>
          {c.erasedAt ? null : (
            <>
              <Fact label="Addresses">
                {c.urls.length === 0 ? (
                  dash
                ) : (
                  <ul className="space-y-1">
                    {c.urls.map((url, index) => (
                      <li key={`${index}-${url}`} className="break-all">
                        {isWebAddress(url) ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--dash-accent)] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                          >
                            {url}
                          </a>
                        ) : (
                          url
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
              <Fact label="What they ask for">
                <span className="whitespace-pre-wrap">{c.summary || "-"}</span>
              </Fact>
            </>
          )}
        </dl>
      </Card>

      <Card title="Blocks">
        {blocks.length === 0 ? (
          <EmptyState text={EMPTY_TEXT.blocks} />
        ) : (
          <BlocksTable rows={blocks} now={now} showComplaint={false} />
        )}
      </Card>

      <Card title="History">
        {events.length === 0 ? (
          <p className="px-5 py-4 text-sm text-[var(--dash-text-2)]">-</p>
        ) : (
          <ol className="divide-y divide-[var(--dash-border)] px-5 py-2">
            {events.map((event) => (
              <li
                key={event.id}
                className="py-2 text-sm break-words text-[var(--dash-text)]"
              >
                <span className="text-[var(--dash-text-2)] tabular-nums">
                  {istDateTime(event.at, now)}
                </span>{" "}
                · {eventLine(event)}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
