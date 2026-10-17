/**
 * The language Mink answers in, chosen by the merchant from the panel menu.
 *
 * ★ A CLOSED LIST, stored in the browser and sent with every message, then
 * validated again on the server before it reaches the prompt. "Match my
 * message" (the default) tells the model to answer in whatever language and
 * script the merchant wrote in, which is also what happens when nothing was
 * chosen. The chrome (labels, chips, skills) stays English; this changes the
 * answers.
 *
 * ★ CLIENT-SAFE AND PURE apart from the two storage helpers.
 */
export const MINK_REPLY_LANGUAGES = [
  { code: "auto", label: "Match my message", instruction: "" },
  { code: "en", label: "English", instruction: "English" },
  {
    code: "hi",
    label: "हिन्दी (Hindi)",
    instruction: "Hindi, in Devanagari script",
  },
  {
    code: "hinglish",
    label: "Hinglish",
    instruction: "Hinglish: conversational Hindi written in Latin letters",
  },
  { code: "ta", label: "தமிழ் (Tamil)", instruction: "Tamil, in Tamil script" },
  {
    code: "te",
    label: "తెలుగు (Telugu)",
    instruction: "Telugu, in Telugu script",
  },
  {
    code: "kn",
    label: "ಕನ್ನಡ (Kannada)",
    instruction: "Kannada, in Kannada script",
  },
  {
    code: "mr",
    label: "मराठी (Marathi)",
    instruction: "Marathi, in Devanagari script",
  },
  {
    code: "bn",
    label: "বাংলা (Bengali)",
    instruction: "Bengali, in Bengali script",
  },
  {
    code: "gu",
    label: "ગુજરાતી (Gujarati)",
    instruction: "Gujarati, in Gujarati script",
  },
  {
    code: "ml",
    label: "മലയാളം (Malayalam)",
    instruction: "Malayalam, in Malayalam script",
  },
  {
    code: "pa",
    label: "ਪੰਜਾਬੀ (Punjabi)",
    instruction: "Punjabi, in Gurmukhi script",
  },
] as const;

export type MinkReplyLanguage = (typeof MINK_REPLY_LANGUAGES)[number]["code"];
export const MINK_REPLY_LANGUAGE_KEY = "storemink:mink-reply-language";

export function isMinkReplyLanguage(
  value: unknown,
): value is MinkReplyLanguage {
  return MINK_REPLY_LANGUAGES.some((entry) => entry.code === value);
}

/** The sentence the prompt's trusted context carries. */
export function minkReplyLanguageInstruction(
  code: MinkReplyLanguage | null | undefined,
): string {
  const entry = MINK_REPLY_LANGUAGES.find((item) => item.code === code);
  if (!entry || !entry.instruction) {
    return "match the language and script of the merchant's message";
  }
  return `${entry.instruction} (answer in it whatever language the merchant writes in)`;
}

export function minkReplyLanguageLabel(code: MinkReplyLanguage): string {
  return (
    MINK_REPLY_LANGUAGES.find((item) => item.code === code)?.label ??
    MINK_REPLY_LANGUAGES[0].label
  );
}

export function readStoredMinkReplyLanguage(): MinkReplyLanguage {
  try {
    const raw = window.localStorage.getItem(MINK_REPLY_LANGUAGE_KEY);
    return isMinkReplyLanguage(raw) ? raw : "auto";
  } catch {
    return "auto";
  }
}

export function storeMinkReplyLanguage(code: MinkReplyLanguage): void {
  try {
    if (code === "auto")
      window.localStorage.removeItem(MINK_REPLY_LANGUAGE_KEY);
    else window.localStorage.setItem(MINK_REPLY_LANGUAGE_KEY, code);
  } catch {
    // A blocked store only costs the preference; the default still applies.
  }
}
