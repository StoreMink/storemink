"use client";

import { useState, type FormEvent } from "react";
import { MinkFace } from "@/components/mink/mink-face";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import {
  CUSTOMISE_FORM_LIMITS,
  customiseFormProblem,
  customiseStorefrontMessage,
  EMPTY_CUSTOMISE_ANSWERS,
  type CustomiseStorefrontAnswers,
} from "@/lib/mink/revamp/customise-form";
import { useChat } from "../chat-context";

const FIELDS: {
  key: keyof CustomiseStorefrontAnswers;
  label: string;
  /** Guidance shown behind the field's "i" button, not under the field. */
  info?: string;
  rows: number;
  required?: boolean;
}[] = [
  {
    key: "business",
    label: "What do you sell, and who buys it?",
    rows: 3,
    required: true,
  },
  {
    key: "look",
    label: "The look and feel you want",
    rows: 2,
  },
  {
    key: "facts",
    label: "Facts about your business",
    info: "Where you are, how your products are made and since when. Mink AI uses only what you write here and never invents claims.",
    rows: 3,
  },
  {
    key: "avoid",
    label: "Anything to avoid",
    rows: 2,
  },
];

// The Storefront page's "Customise storefront" button (owner, 31 Oct 2026):
// a few questions about the business, then ONE message to Mink AI in a new
// chat, where the redesign starts and its card shows the progress. The form
// only writes the message (lib/mink/revamp/customise-form.ts); the chat run
// checks permissions and credits and makes the redesign, as it does for a
// request typed in the chat.
export function CustomiseStorefrontButton({
  className,
}: {
  className: string;
}) {
  const { startExpandedChat, enabled } = useChat();
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<CustomiseStorefrontAnswers>(
    EMPTY_CUSTOMISE_ANSWERS,
  );
  const [problem, setProblem] = useState<string | null>(null);

  // Mink AI is off for this store: there is no chat to hand the answers to.
  if (!enabled) return null;

  function submit(event: FormEvent) {
    event.preventDefault();
    const issue = customiseFormProblem(answers);
    if (issue) {
      setProblem(issue);
      return;
    }
    setOpen(false);
    startExpandedChat(customiseStorefrontMessage(answers));
    setAnswers(EMPTY_CUSTOMISE_ANSWERS);
    setProblem(null);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <MinkFace size={18} />
        Customise storefront
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[540px]">
          <form onSubmit={submit} noValidate className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Customise your storefront</DialogTitle>
              <DialogDescription>
                Mink AI redesigns your storefront in a new chat. Nothing changes
                on your store until you approve it.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              {FIELDS.map((field) => {
                const id = `customise-${field.key}`;
                const errorId =
                  field.key === "business" && problem
                    ? `${id}-error`
                    : undefined;
                return (
                  <div key={field.key} className="grid gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <label
                        htmlFor={id}
                        className="text-sm font-medium text-[#111827]"
                      >
                        {field.label}
                        {!field.required && (
                          <span className="font-normal text-[#5b6472]">
                            {" "}
                            (optional)
                          </span>
                        )}
                      </label>
                      {field.info && (
                        <InfoTip label={`About ${field.label.toLowerCase()}`}>
                          {field.info}
                        </InfoTip>
                      )}
                    </div>
                    <textarea
                      id={id}
                      rows={field.rows}
                      maxLength={CUSTOMISE_FORM_LIMITS[field.key]}
                      value={answers[field.key]}
                      required={field.required}
                      aria-invalid={errorId ? true : undefined}
                      aria-describedby={errorId}
                      onChange={(event) => {
                        const value = event.target.value;
                        setAnswers((current) => ({
                          ...current,
                          [field.key]: value,
                        }));
                        if (field.key === "business") setProblem(null);
                      }}
                      className={`dash-input field-sizing-content max-h-48 w-full resize-none ${
                        field.rows > 2 ? "min-h-[84px]" : "min-h-[62px]"
                      }`}
                    />
                    {errorId && (
                      <p
                        id={errorId}
                        role="alert"
                        className="text-xs text-[#b42318]"
                      >
                        {problem}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Customise</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
