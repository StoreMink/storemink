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
  hint?: string;
  placeholder: string;
  rows: number;
  required?: boolean;
}[] = [
  {
    key: "business",
    label: "What do you sell, and who buys it?",
    placeholder:
      "Cold-pressed mustard and groundnut oils for families who cook at home",
    rows: 3,
    required: true,
  },
  {
    key: "look",
    label: "The look and feel you want",
    placeholder: "Warm and earthy, like a village kitchen",
    rows: 2,
  },
  {
    key: "facts",
    label: "Facts about your business",
    hint: "Where you are, how your products are made, since when. Mink AI uses only what you write here and never invents claims.",
    placeholder: "Pressed in our own mill in Faridkot since 1998",
    rows: 3,
  },
  {
    key: "avoid",
    label: "Anything to avoid",
    placeholder: "No bright pink, no slang",
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
        <DialogContent className="sm:max-w-[560px]">
          <form onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>Customise your storefront</DialogTitle>
              <DialogDescription>
                Tell Mink AI about your business. It redesigns your pages,
                header and footer for you, then shows you everything to review
                before anything changes on your store.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              {FIELDS.map((field) => {
                const id = `customise-${field.key}`;
                const hintId = field.hint ? `${id}-hint` : undefined;
                const errorId =
                  field.key === "business" && problem
                    ? `${id}-error`
                    : undefined;
                return (
                  <div key={field.key}>
                    <label
                      htmlFor={id}
                      className="block text-sm font-medium text-[#111827]"
                    >
                      {field.label}
                      {!field.required && (
                        <span className="font-normal text-[#5b6472]">
                          {" "}
                          (optional)
                        </span>
                      )}
                    </label>
                    {field.hint && (
                      <p
                        id={hintId}
                        className="mt-0.5 text-xs leading-5 text-[#5b6472]"
                      >
                        {field.hint}
                      </p>
                    )}
                    <textarea
                      id={id}
                      rows={field.rows}
                      maxLength={CUSTOMISE_FORM_LIMITS[field.key]}
                      value={answers[field.key]}
                      placeholder={field.placeholder}
                      required={field.required}
                      aria-invalid={errorId ? true : undefined}
                      aria-describedby={
                        [hintId, errorId].filter(Boolean).join(" ") || undefined
                      }
                      onChange={(event) => {
                        const value = event.target.value;
                        setAnswers((current) => ({
                          ...current,
                          [field.key]: value,
                        }));
                        if (field.key === "business") setProblem(null);
                      }}
                      className="dash-input mt-1.5 w-full resize-y"
                    />
                    {errorId && (
                      <p
                        id={errorId}
                        role="alert"
                        className="mt-1 text-xs text-[#b42318]"
                      >
                        {problem}
                      </p>
                    )}
                  </div>
                );
              })}
              <p className="text-xs leading-5 text-[#5b6472]">
                Mink AI uses the products already in your store and keeps your
                categories as they are. The redesign opens in a chat, where you
                can follow it and ask for changes.
              </p>
            </div>
            <DialogFooter className="mt-5">
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
