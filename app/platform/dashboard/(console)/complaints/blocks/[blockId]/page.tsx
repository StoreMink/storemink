import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  getBlock,
  type BlockDetail,
  type BlockPage,
} from "@/lib/moderation/console-read";
import { BLOCK_REASONS, isOneOf, reasonLabel } from "@/lib/moderation/kinds";
import { loggableError } from "@/lib/db/errors";
import { logError } from "@/lib/observability/logger";
import { canManage, requireOperator } from "../../../require-operator";
import {
  BlocksTable,
  blockHref,
  blockKindLabel,
  complaintHref,
  complaintsHref,
  eventLine,
  istDateTime,
} from "../../complaints-console";
import {
  ArchiveCopy,
  BlockActions,
  MarkRemovedButton,
  RetryNowButton,
  StoreReplyForms,
} from "./block-detail";

// ---------------------------------------------------------------------------
// A block (takedown design 6.6, stage T16b): what was blocked and why, where
// its file or its store copy stands, the archived copy, the conversation
// with the store and the record.
//
// ★ GATED ON ITS OWN with `requireOperator()` (CODEBASE §39) before
// `getBlock` (T13) reads it under `withService`.
//
// ★ A MEMBER IS NOT OFFERED A SUPERADMIN'S CONTROLS (design 3.10): Tell the
// store now, Lift block, and the archived copy's buttons are rendered for a
// superadmin only; every action checks the role again on the server.
//
// ★ INDIA TIME for every date (complaints-console.tsx `istDateTime`), and a
// failed read says so rather than rendering an empty block.
// ---------------------------------------------------------------------------

export const metadata = { title: "Block · StoreMink Admin" };

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
      <div className="dash-card-body">{children}</div>
    </section>
  );
}

const LINK =
  "text-[var(--dash-accent)] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

const dash = <span className="text-[var(--dash-text-2)]">-</span>;

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** "Product blocked: Blue mug", "Store suspended: Crumb & Co" (design 6.6). */
function heading(block: BlockDetail): string {
  if (block.kind === "store") return `Store suspended: ${block.label}`;
  return `${blockKindLabel(block.kind)} blocked: ${block.label}`;
}

/** The chip beside the heading: "Blocked", "Suspended" or "Lifted". */
function chip(block: BlockDetail): { text: string; tone: string } {
  if (block.status === "lifted") {
    return { text: "Lifted", tone: "dash-badge-grey" };
  }
  if (block.kind === "store") {
    return { text: "Suspended", tone: "dash-badge-storemink" };
  }
  return { text: "Blocked", tone: "dash-badge-storemink" };
}

/** "Store told" (design 6.6). */
function toldText(block: BlockDetail): string {
  if (!block.tellStore) return "Not told: kept from the store under an order";
  if (block.merchantNotifiedAt) {
    return `${istDateTime(block.merchantNotifiedAt)} by email`;
  }
  if (block.noticeEmailFailed) return "Email failed, retrying";
  return "Not yet";
}

type FileLine = {
  text: string;
  retry?: boolean;
  markRemoved?: boolean;
};

/** A failure the follow-up wrote that a retry cannot change. */
const PERMANENT_STORAGE_ERROR =
  /^The file (changed before|changed after|was already)/;

/**
 * "File" (design 6.6), by where the file stands; the old-storage line is gone
 * (A2). A failed replacement shows the follow-up's own sentence.
 */
function fileLine(block: BlockDetail): FileLine | null {
  switch (block.fileStage) {
    case "archived":
      return {
        text: "Archived. It is replaced with the placeholder about a minute after the block.",
      };
    case "replaced":
      return { text: "Replaced with the placeholder" };
    case "copying":
      return {
        text: "Not archived yet, still at its storage address",
        retry: true,
      };
    case "copy_failed":
      return { text: "The copy failed after 24 hours. Retry it.", retry: true };
    case "replace_failed": {
      const error = block.storageError.trim();
      if (!error) {
        return {
          text: "The file changed after StoreMink copied it, so it was not replaced. Block it again to keep a copy of the new version.",
        };
      }
      return { text: error, retry: !PERMANENT_STORAGE_ERROR.test(error) };
    }
    case "remove_by_hand":
      return {
        text: "Built into a theme: remove it in the code",
        markRemoved: true,
      };
    case "removed_by_hand":
      return { text: "Removed by hand" };
    case "not_ours":
      return { text: "Not StoreMink's file" };
    case "restoring":
      return { text: "Restoring the original" };
    case "restored":
      return { text: "Restored" };
    case "not_restored":
      return { text: "Not restored: the file was changed or removed" };
    case "cancelled":
      return { text: "Replacement cancelled when the block was lifted" };
    default:
      return null;
  }
}

const count = (n: number) => n.toLocaleString("en-IN");

/** "Store copy" (design 6.6) and an item's own file copies, while they run. */
function copyLine(block: BlockDetail): FileLine | null {
  const files = block.archive;
  if (!files) return null;
  if (files.filesState === "pending") {
    return {
      text: `Copying files: ${count(files.copied)} of ${count(files.total)}`,
    };
  }
  if (files.filesState === "failed") {
    return { text: "The copy failed after 24 hours. Retry it.", retry: true };
  }
  if (block.kind === "store" && files.filesState === "copied") {
    return {
      text: `Complete: ${count(files.total)} files, ${count(files.missing)} missing`,
    };
  }
  return null;
}

function LineWithButtons({
  line,
  blockId,
}: {
  line: FileLine;
  blockId: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
      <span>{line.text}</span>
      {line.retry ? <RetryNowButton blockId={blockId} /> : null}
      {line.markRemoved ? <MarkRemovedButton blockId={blockId} /> : null}
    </div>
  );
}

export default async function BlockDetailPage({
  params,
}: {
  params: Promise<{ blockId: string }>;
}) {
  const viewer = await requireOperator();
  const superadmin = canManage(viewer);
  const { blockId } = await params;
  const now = new Date();

  let page: BlockPage | null;
  try {
    page = await getBlock(blockId);
  } catch (err) {
    logError("complaints console: block read failed", loggableError(err));
    return (
      <div className="dash-page-enter">
        <p role="alert" className="text-sm text-[var(--dash-text)]">
          This block could not be read just now. Refresh the page to try again.
        </p>
      </div>
    );
  }
  if (!page) notFound();

  const { block, parent, children, messages, events, archive } = page;
  const tone = chip(block);
  const storeName = block.store?.name || block.storeLabel || "the store";
  const reason = isOneOf(BLOCK_REASONS, block.reasonKind)
    ? reasonLabel(block.reasonKind)
    : block.reasonKind;
  const file = block.kind === "file" ? fileLine(block) : null;
  const copy = block.kind === "file" ? null : copyLine(block);
  const liveImageBlocks = children.filter(
    (child) => child.status !== "lifted",
  ).length;
  const suspended =
    block.store?.status === "suspended" ||
    (block.kind === "store" && block.status !== "lifted");
  const asksAgain =
    block.reasonKind === "store_request"
      ? "Asked us to show it again"
      : "Asked us to review it again";

  return (
    <div className="dash-page-enter mx-auto w-full max-w-4xl space-y-6">
      <div>
        <Link
          href={complaintsHref({ view: "blocks" })}
          className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--dash-text-2)] hover:text-[var(--dash-text)] pointer-coarse:min-h-11"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
          Complaints
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold break-words text-[var(--dash-text)]">
            {heading(block)}
          </h1>
          <span className={`dash-badge ${tone.tone}`}>{tone.text}</span>
        </div>
      </div>

      <BlockActions
        blockId={block.id}
        kind={block.kind}
        label={block.label}
        storeName={storeName}
        storeStatusBefore={block.storeStatusBefore}
        status={block.status}
        told={block.tellStore}
        fileStage={block.fileStage}
        replacingNow={block.replacingNow}
        archive={
          archive
            ? {
                keepUntil: archive.keepUntil,
                legalHold: archive.legalHold,
                purgedAt: archive.purgedAt,
              }
            : null
        }
        liveImageBlocks={liveImageBlocks}
        superadmin={superadmin}
      />

      <Card title="Details">
        <dl className="divide-y divide-[var(--dash-border)]">
          <Fact label="Store">
            {block.storeId && block.storeLabel ? (
              <Link
                href={`/dashboard/stores/${block.storeId}`}
                className={LINK}
              >
                {block.storeLabel}
              </Link>
            ) : (
              block.storeLabel || dash
            )}
          </Fact>
          <Fact label="Address">
            {block.url && isWebAddress(block.url) ? (
              <a
                href={block.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`break-all ${LINK}`}
              >
                {block.url}
              </a>
            ) : (
              <span className="break-all">{block.url || "-"}</span>
            )}
          </Fact>
          <Fact label="Blocked">
            {`${istDateTime(block.blockedAt, now)} by ${block.blockedBy}`}
          </Fact>
          <Fact label="Reason">{reason}</Fact>
          <Fact label="Legal basis">{block.legalBasis || dash}</Fact>
          <Fact label="Complaint">
            {block.complaintRef ? (
              <Link
                href={complaintHref(block.complaintRef)}
                className={`tabular-nums ${LINK}`}
              >
                {block.complaintRef}
              </Link>
            ) : block.reasonKind === "store_request" ? (
              "No complaint: the store asked us"
            ) : (
              "No complaint: StoreMink found it"
            )}
          </Fact>
          <Fact label="Store told">{toldText(block)}</Fact>
          <Fact label="Store opened the notice">
            {block.tellStore
              ? block.merchantSeenAt
                ? istDateTime(block.merchantSeenAt, now)
                : "Not yet"
              : dash}
          </Fact>
          {block.liftedAt ? (
            <Fact label="Lifted">
              {`${istDateTime(block.liftedAt, now)}${block.liftedBy ? ` by ${block.liftedBy}` : ""}${block.liftNote ? `: ${block.liftNote}` : ""}`}
            </Fact>
          ) : null}
          {parent ? (
            <Fact label="Part of">
              <Link href={blockHref(parent.id)} className={LINK}>
                {parent.kind === "store"
                  ? `Store suspended: ${parent.label}`
                  : `${blockKindLabel(parent.kind)} blocked: ${parent.label}`}
              </Link>
            </Fact>
          ) : null}
          {file ? (
            <Fact label="File">
              <LineWithButtons line={file} blockId={block.id} />
            </Fact>
          ) : null}
          {block.kind === "store" && copy ? (
            <Fact label="Store copy">
              <LineWithButtons line={copy} blockId={block.id} />
            </Fact>
          ) : null}
        </dl>
      </Card>

      {children.length > 0 ? (
        <section className="dash-card">
          <div className="dash-card-header">
            <h2 className="dash-card-title">Blocks</h2>
          </div>
          <BlocksTable rows={children} now={now} showComplaint={false} />
        </section>
      ) : null}

      {archive ? (
        <Card title="Archived copy">
          <div className="space-y-3">
            {block.kind !== "store" && copy ? (
              <LineWithButtons line={copy} blockId={block.id} />
            ) : null}
            <ArchiveCopy
              blockId={block.id}
              archive={archive}
              superadmin={superadmin}
            />
          </div>
        </Card>
      ) : null}

      <Card title="Conversation with the store">
        <div className="space-y-4">
          {suspended ? (
            <p className="text-sm text-[var(--dash-text)]">
              This store can&apos;t open its dashboard while suspended. Its
              replies arrive by email.
            </p>
          ) : null}
          {messages.length > 0 ? (
            <ol className="space-y-3">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className="rounded-[var(--dash-radius-sm)] border border-[var(--dash-border)] p-3"
                >
                  <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--dash-text-2)]">
                    <span className="break-all">{`${message.author} · ${istDateTime(message.at, now)}`}</span>
                    {message.fromSide === "store" && message.asksReview ? (
                      <span className="dash-badge dash-badge-amber">
                        {asksAgain}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-sm break-words whitespace-pre-wrap text-[var(--dash-text)]">
                    {message.body}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
          {block.tellStore ? (
            <StoreReplyForms blockId={block.id} />
          ) : (
            <p className="text-sm text-[var(--dash-text-2)]">
              The store has not been told about this block, so there is no one
              to reply to yet.
            </p>
          )}
        </div>
      </Card>

      <Card title="History">
        {events.length === 0 ? (
          <p className="text-sm text-[var(--dash-text-2)]">-</p>
        ) : (
          <ol className="space-y-2">
            {events.map((event) => (
              <li key={event.id} className="text-sm text-[var(--dash-text)]">
                <span className="text-[var(--dash-text-2)] tabular-nums">
                  {istDateTime(event.at, now)}
                </span>
                {` · ${eventLine(event)}`}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
