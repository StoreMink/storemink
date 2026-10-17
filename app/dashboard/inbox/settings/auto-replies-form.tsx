"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Toggle } from "../../components/feature-toggles";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";
import {
  saveWhatsAppAutoReplies,
  type AutoRepliesView,
} from "@/app/actions/whatsapp-auto-reply-actions";
import {
  AUTO_REPLY_MAX_CHARS,
  AWAY_AFTER_HUMAN_REPLY_HOURS,
  DEFAULT_PERSON_TEXT,
  MENU_ACTIONS,
  MENU_ACTION_LABELS,
  MENU_BUTTON_TITLE_MAX_CHARS,
  MENU_MAX_BUTTONS,
  MENU_PROMPT_TEXT,
  MINK_MODE_LABELS,
  WELCOME_QUIET_DAYS,
  validateAutoReplySettings,
  type MenuButton,
  type MenuButtonAction,
  type MinkMode,
  type WhatsAppAutoReplySettings,
} from "@/lib/whatsapp/auto-reply-settings";
import {
  ALL_DAY,
  WEEK_DAYS,
  WEEK_DAY_LABELS,
  endsNextDay,
  isAllDay,
  type BusinessHours,
  type DayHours,
  type WeekDay,
} from "@/lib/whatsapp/business-hours";

// Inbox → Automatic replies. One form for the welcome message, the away
// message and the hours it follows, and order-status answers, saved together
// so the hours and the away message can never disagree.

type DayMode = "open" | "all_day" | "closed";

function modeOf(day: DayHours | null): DayMode {
  if (!day) return "closed";
  return isAllDay(day) ? "all_day" : "open";
}

/** What "Open" starts from when a closed day is opened. */
const OPEN_DEFAULT: DayHours = { open: "10:00", close: "19:00" };

function HoursEditor({
  hours,
  disabled,
  onChange,
}: {
  hours: BusinessHours;
  disabled: boolean;
  onChange: (next: BusinessHours) => void;
}) {
  const set = (day: WeekDay, value: DayHours | null) =>
    onChange({ ...hours, [day]: value });

  return (
    <div className="divide-y divide-[rgba(17,24,39,0.06)] rounded-[10px] border border-[rgba(17,24,39,0.08)]">
      {WEEK_DAYS.map((day) => {
        const value = hours[day];
        const mode = modeOf(value);
        const label = WEEK_DAY_LABELS[day];
        return (
          <div
            key={day}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
          >
            <span className="w-24 shrink-0 text-[13px] font-medium">
              {label}
            </span>
            <select
              className="dash-input w-32"
              aria-label={`${label} hours`}
              value={mode}
              disabled={disabled}
              onChange={(e) => {
                const next = e.target.value as DayMode;
                set(
                  day,
                  next === "closed"
                    ? null
                    : next === "all_day"
                      ? ALL_DAY
                      : value && !isAllDay(value)
                        ? value
                        : OPEN_DEFAULT,
                );
              }}
            >
              <option value="open">Open</option>
              <option value="all_day">Open all day</option>
              <option value="closed">Closed</option>
            </select>
            {/* ★ Each time has its own visible label and, on a phone, its own
                full-width line: a phone renders inputs at 16px, where two
                times side by side no longer fit and get cut off. */}
            {mode === "open" && value ? (
              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 text-[13px] sm:w-auto">
                <label className="flex w-full items-center gap-2 sm:w-auto">
                  <span className="w-12 shrink-0 text-[var(--dash-text-3)] sm:w-auto">
                    Opens
                  </span>
                  <input
                    type="time"
                    className="dash-input min-w-0 flex-1 sm:w-[8.5rem] sm:flex-none"
                    aria-label={`${label} opens at`}
                    value={value.open}
                    step={300}
                    disabled={disabled}
                    onChange={(e) =>
                      set(day, {
                        ...value,
                        open: e.target.value || value.open,
                      })
                    }
                  />
                </label>
                <label className="flex w-full items-center gap-2 sm:w-auto">
                  <span className="w-12 shrink-0 text-[var(--dash-text-3)] sm:w-auto">
                    Closes
                  </span>
                  <input
                    type="time"
                    className="dash-input min-w-0 flex-1 sm:w-[8.5rem] sm:flex-none"
                    aria-label={`${label} closes at`}
                    value={value.close}
                    step={300}
                    disabled={disabled}
                    onChange={(e) =>
                      set(day, {
                        ...value,
                        close: e.target.value || value.close,
                      })
                    }
                  />
                  {endsNextDay(value) ? (
                    <span className="shrink-0 text-[12px] text-[var(--dash-text-3)]">
                      next day
                    </span>
                  ) : null}
                </label>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function MessageBox({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <textarea
        className="dash-input w-full"
        rows={3}
        aria-label={label}
        value={value}
        maxLength={AUTO_REPLY_MAX_CHARS}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="mt-1 text-right text-[12px] text-[var(--dash-text-3)]">
        {value.length} / {AUTO_REPLY_MAX_CHARS}
      </div>
    </div>
  );
}

/**
 * A button's id is generated once and kept: it is what a customer's tap
 * carries back (menu-payload.ts), so renaming or reordering buttons must not
 * change which one a tap on an older message means.
 */
function newButtonId(): string {
  return `b${Math.random().toString(36).slice(2, 10)}`;
}

/** What a button answers with, for the merchant to see before a customer does. */
function describeButton(b: MenuButton): string {
  if (b.action === "order_status") {
    return "Answers with the status of the customer's recent orders, like Order status below.";
  }
  if (b.action === "person") {
    return "Hands the conversation to your team in Needs reply.";
  }
  return "Sends the message as written.";
}

function MenuEditor({
  buttons,
  disabled,
  onChange,
}: {
  buttons: MenuButton[];
  disabled: boolean;
  onChange: (next: MenuButton[]) => void;
}) {
  const update = (index: number, patch: Partial<MenuButton>) =>
    onChange(buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  const remove = (index: number) =>
    onChange(buttons.filter((_, i) => i !== index));
  const add = () =>
    onChange([
      ...buttons,
      { id: newButtonId(), title: "", action: "text", text: "" },
    ]);

  return (
    <div className="flex flex-col gap-3">
      {buttons.map((b, index) => {
        const n = index + 1;
        return (
          <div
            key={b.id}
            className="rounded-[10px] border border-[rgba(17,24,39,0.08)] px-3 py-3"
          >
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
                <span className="text-[var(--dash-text-3)]">
                  Button {n} label
                </span>
                <input
                  type="text"
                  className="dash-input w-full"
                  aria-label={`Menu button ${n} label`}
                  value={b.title}
                  maxLength={MENU_BUTTON_TITLE_MAX_CHARS}
                  disabled={disabled}
                  onChange={(e) => update(index, { title: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[13px]">
                <span className="text-[var(--dash-text-3)]">When tapped</span>
                <select
                  className="dash-input w-44"
                  aria-label={`Menu button ${n} action`}
                  value={b.action}
                  disabled={disabled}
                  onChange={(e) =>
                    update(index, {
                      action: e.target.value as MenuButtonAction,
                    })
                  }
                >
                  {MENU_ACTIONS.map((action) => (
                    <option key={action} value={action}>
                      {MENU_ACTION_LABELS[action]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="dash-btn dash-btn-ghost dash-btn-sm"
                aria-label={`Remove menu button ${n}`}
                disabled={disabled}
                onClick={() => remove(index)}
              >
                Remove
              </button>
            </div>
            <p className="mt-2 text-[12px] text-[var(--dash-text-3)]">
              {b.title.length} / {MENU_BUTTON_TITLE_MAX_CHARS} characters.{" "}
              {describeButton(b)}
            </p>
            {b.action !== "order_status" ? (
              <div className="mt-2">
                <textarea
                  className="dash-input w-full"
                  rows={2}
                  aria-label={`Menu button ${n} message`}
                  placeholder={
                    b.action === "person" ? DEFAULT_PERSON_TEXT : undefined
                  }
                  value={b.text}
                  maxLength={AUTO_REPLY_MAX_CHARS}
                  disabled={disabled}
                  onChange={(e) => update(index, { text: e.target.value })}
                />
                {b.action === "person" ? (
                  <p className="mt-1 text-[12px] text-[var(--dash-text-3)]">
                    Optional. Leave it blank to send the message shown.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {buttons.length < MENU_MAX_BUTTONS ? (
        <div>
          <button
            type="button"
            className="dash-btn dash-btn-ghost dash-btn-sm"
            disabled={disabled}
            onClick={add}
          >
            Add a button
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-[var(--dash-text-3)]">
          WhatsApp allows {MENU_MAX_BUTTONS} buttons on a message.
        </p>
      )}
    </div>
  );
}

/** What Mink does with a question, one of the two ways it can be on. */
const MINK_CHOICES: { mode: Exclude<MinkMode, "off">; detail: string }[] = [
  {
    mode: "helps",
    detail:
      "Mink replies on its own when the answer is in your store's facts: the customer's own orders, products and prices, stock, delivery to their PIN, offers, your policies and hours. Anything else, and every complaint, refund, cancellation or request for a person, waits for you in Needs reply with Mink's draft attached.",
  },
  {
    mode: "drafts",
    detail:
      "Mink never sends anything. Every message waits for you in Needs reply with Mink's suggested reply above the message box; send it, change it, or ignore it.",
  },
];

function MinkCard({
  mode,
  disabled,
  onChange,
}: {
  mode: MinkMode;
  disabled: boolean;
  onChange: (next: MinkMode) => void;
}) {
  return (
    <Card
      title="Mink AI answers"
      description="Mink answers customers' questions from your store's own facts, or drafts a reply for you. Replies that are sent use Mink credits; a draft nobody sends does not."
      on={mode !== "off"}
      disabled={disabled}
      onToggle={(on) => onChange(on ? "helps" : "off")}
    >
      <div
        className="flex flex-col gap-3"
        role="radiogroup"
        aria-label="What Mink AI does"
      >
        {MINK_CHOICES.map((choice) => (
          <label
            key={choice.mode}
            className="flex cursor-pointer items-start gap-3 rounded-[10px] border border-[rgba(17,24,39,0.08)] px-3 py-3 text-[13px]"
          >
            <input
              type="radio"
              name="mink-mode"
              className="mt-0.5"
              value={choice.mode}
              checked={mode === choice.mode}
              disabled={disabled || mode === "off"}
              onChange={() => onChange(choice.mode)}
            />
            <span className="flex flex-col gap-1">
              <span className="font-semibold">
                {MINK_MODE_LABELS[choice.mode]}
              </span>
              <span className="leading-relaxed text-[var(--dash-text-3)]">
                {choice.detail}
              </span>
            </span>
          </label>
        ))}
        <p className="text-[12px] leading-relaxed text-[var(--dash-text-3)]">
          Mink never cancels, refunds, changes a price or an address, or applies
          a code: it only answers, and it tells the customer a person can take
          over. It replies in the language the customer wrote in. Your Mink
          credits are under Plans &amp; Billing.
        </p>
      </div>
    </Card>
  );
}

function Card({
  title,
  description,
  on,
  disabled,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  on: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <section className="dash-card">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">{title}</div>
          <div className="dash-card-sub max-w-xl">{description}</div>
        </div>
        <Toggle on={on} disabled={disabled} onChange={onToggle} label={title} />
      </div>
      {children ? (
        <div className={`dash-card-body ${on ? "" : "opacity-60"}`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function AutoRepliesForm({ view }: { view: AutoRepliesView }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [settings, setSettings] = useState<WhatsAppAutoReplySettings>(
    view.settings,
  );
  const [baseline, setBaseline] = useState(() => JSON.stringify(view.settings));
  const dirty = JSON.stringify(settings) !== baseline;
  useUnsavedChangesWarning(dirty);

  const disabled = !view.canManage || isPending;
  const patch = (next: Partial<WhatsAppAutoReplySettings>) =>
    setSettings((s) => ({ ...s, ...next }));

  const save = () => {
    const checked = validateAutoReplySettings(settings);
    if (!checked.ok) {
      toast.error(checked.error);
      return;
    }
    startTransition(async () => {
      const result = await saveWhatsAppAutoReplies(checked.settings);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setSettings(checked.settings);
      setBaseline(JSON.stringify(checked.settings));
      toast.success("Automatic replies saved.");
      router.refresh();
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card
        title="Welcome message"
        description={`Sent when a customer messages you for the first time, or after ${WELCOME_QUIET_DAYS} days with no messages either way. The conversation still waits for you in Needs reply.`}
        on={settings.welcomeEnabled}
        disabled={disabled}
        onToggle={(on) => patch({ welcomeEnabled: on })}
      >
        <MessageBox
          label="Welcome message text"
          value={settings.welcomeText}
          disabled={disabled}
          onChange={(welcomeText) => patch({ welcomeText })}
        />
      </Card>

      <Card
        title="Away message"
        description={`Sent when a customer messages you outside your business hours, once until you're open again. It isn't sent if someone on your team replied to that customer in the last ${AWAY_AFTER_HUMAN_REPLY_HOURS} hours.`}
        on={settings.awayEnabled}
        disabled={disabled}
        onToggle={(on) => patch({ awayEnabled: on })}
      >
        <div className="flex flex-col gap-4">
          <MessageBox
            label="Away message text"
            value={settings.awayText}
            disabled={disabled}
            onChange={(awayText) => patch({ awayText })}
          />
          <div>
            <div className="mb-2 text-[13px] font-semibold">Business hours</div>
            <HoursEditor
              hours={settings.hours}
              disabled={disabled}
              onChange={(hours) => patch({ hours })}
            />
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--dash-text-3)]">
              Times are in {view.timeZoneLabel}.{" "}
              {view.canChangeTimeZone ? (
                <>
                  Change the time zone under{" "}
                  <Link href="/dashboard/settings" className="underline">
                    Settings
                  </Link>
                  .
                </>
              ) : null}{" "}
              A closing time earlier than the opening time runs into the next
              day. To be away for a holiday, set those days to Closed.
            </p>
          </div>
        </div>
      </Card>

      <Card
        title="Menu buttons"
        description={`Up to ${MENU_MAX_BUTTONS} buttons under the welcome message, and again whenever a customer types "menu". Each one checks their order, hands the chat to your team, or sends a message you write.`}
        on={settings.menuEnabled}
        disabled={disabled}
        onToggle={(on) => patch({ menuEnabled: on })}
      >
        <MenuEditor
          buttons={settings.menuButtons}
          disabled={disabled}
          onChange={(menuButtons) => patch({ menuButtons })}
        />
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--dash-text-3)]">
          {settings.welcomeEnabled
            ? "The buttons go out with your welcome message."
            : `With the welcome message off, the buttons go out under "${MENU_PROMPT_TEXT}" when a customer asks for the menu.`}
        </p>
      </Card>

      <Card
        title="Order status"
        description="When a customer asks where their order is, they get its status and tracking link straight away, for orders placed with the number they are messaging from. If no order matches, or a delivery has a problem, the conversation waits for you in Needs reply."
        on={settings.orderStatusEnabled}
        disabled={disabled}
        onToggle={(on) => patch({ orderStatusEnabled: on })}
      >
        <div className="rounded-[10px] bg-[rgba(17,24,39,0.04)] px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-line">
          {
            "Here's the latest on your order:\n\nOrder ORD10011027, placed 12 Oct: On the way with Delhivery. Expected by 15 Oct.\nTrack it: https://…"
          }
        </div>
        <p className="mt-2 text-[12px] text-[var(--dash-text-3)]">
          An example. Customers can ask in English or Hindi, for example
          &ldquo;where is my order&rdquo; or &ldquo;mera order kab
          aayega&rdquo;.
        </p>
      </Card>

      <MinkCard
        mode={settings.minkMode}
        disabled={disabled}
        onChange={(minkMode) => patch({ minkMode })}
      />

      {view.canManage ? (
        <div className="flex justify-end">
          <Button onClick={save} disabled={!dirty || isPending}>
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      ) : (
        <p className="text-[13px] text-[var(--dash-text-3)]">
          You can see these settings but not change them.
        </p>
      )}
    </div>
  );
}
