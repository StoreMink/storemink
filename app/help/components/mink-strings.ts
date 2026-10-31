/**
 * The Help Centre Mink AI chat's own words, in each language of its language
 * menu (lib/help/languages.ts). Mink AI's answers come from the model; these
 * are the chat's buttons, labels, hints and spoken phrases around them.
 *
 * ★ ENGLISH IS THE REFERENCE, and its accessible names are pinned by the
 * Help tests ("Ask Mink AI a StoreMink question", "Send question" and the
 * rest), so change one only with its test.
 *
 * ★ THE OTHER EIGHT WERE WRITTEN FOR THE FIRST BUILD AND NEED A NATIVE
 * SPEAKER'S REVIEW BEFORE LAUNCH. StoreMink names (Mink AI, StoreMink, Help
 * Centre, POS) stay in Latin letters, as the product shows them. Mink AI
 * refers to itself without a gendered verb, as the dashboard's Mink does.
 */

import type { HelpLanguageCode } from "@/lib/help/languages";
import type { HelpTalkPhrases } from "./help-voice";

export type MinkTalkStatus =
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

export interface MinkStrings {
  subtitle: string;
  dialogLabel: string;
  introLead: string;
  welcomeTitle: string;
  welcomeText: string;
  examplesLabel: string;
  starters: readonly [string, string, string, string];
  inputLabel: string;
  placeholder: string;
  placeholderTranscribing: string;
  hintKeys: string;
  hintRecording: string;
  hintTranscribing: string;
  dictate: string;
  talk: string;
  send: string;
  cancelDictation: string;
  finishDictation: string;
  done: string;
  newChat: string;
  newChatLabel: string;
  recentChats: string;
  maximize: string;
  restore: string;
  close: string;
  back: string;
  language: string;
  /** Joined after "Mink AI" to name the header menu ("Mink AI options"). */
  options: string;
  recent: string;
  noRecent: string;
  savedHere: string;
  deleteChat: string;
  browseGuides: string;
  searchGuides: string;
  saidAloud: string;
  sourceGuides: string;
  readFullGuide: string;
  important: string;
  includeDetails: string;
  thinking: string;
  thinkingLabel: string;
  copy: string;
  copied: string;
  listen: string;
  stopListening: string;
  helpful: string;
  notHelpful: string;
  thanks: string;
  emailSupport: string;
  talkStatus: Record<MinkTalkStatus, string>;
  skip: string;
  skipLabel: string;
  end: string;
  endLabel: string;
  voiceGroup: string;
  dismiss: string;
  stillAnswering: string;
  connectionError: string;
  copyError: string;
  ratingError: string;
  phrases: HelpTalkPhrases;
}

const en: MinkStrings = {
  subtitle: "Answers from StoreMink Help guides",
  dialogLabel: "Mink AI Help Assistant",
  introLead: "Hi! I’m Mink AI.",
  welcomeTitle: "Hi, I’m Mink AI",
  welcomeText:
    "Describe your StoreMink issue, and I’ll guide you using Help Centre guides.",
  examplesLabel: "Example questions",
  starters: [
    "How do I add my first product?",
    "How do I connect my domain?",
    "How do I process a POS sale?",
    "How do I set up shipping?",
  ],
  inputLabel: "Ask Mink AI a StoreMink question",
  placeholder: "Ask how to do something…",
  placeholderTranscribing: "Turning your voice into text…",
  hintKeys: "Enter to send · Shift + Enter for a new line",
  hintRecording: "Listening… press Done when you finish",
  hintTranscribing: "Transcribing…",
  dictate: "Dictate your question",
  talk: "Talk with Mink AI",
  send: "Send question",
  cancelDictation: "Cancel dictation",
  finishDictation: "Finish dictation",
  done: "Done",
  newChat: "New chat",
  newChatLabel: "Start a new conversation",
  recentChats: "Recent chats",
  maximize: "Maximize Mink AI",
  restore: "Restore Mink AI drawer",
  close: "Close Mink AI",
  back: "Back",
  language: "Language",
  options: "options",
  recent: "Recent",
  noRecent: "Your chats appear here.",
  savedHere: "Saved in this browser only.",
  deleteChat: "Delete chat",
  browseGuides: "Browse all guides",
  searchGuides: "Search the guides",
  saidAloud: "Said aloud",
  sourceGuides: "Source guides",
  readFullGuide: "Read the full guide",
  important: "Important",
  includeDetails: "Include these details in your reply",
  thinking: "Reading the Help guides…",
  thinkingLabel: "Finding the best answer",
  copy: "Copy answer",
  copied: "Copied",
  listen: "Read this answer aloud",
  stopListening: "Stop reading this answer",
  helpful: "Helpful",
  notHelpful: "Not helpful",
  thanks:
    "Thanks. Your rating, your question and this answer were sent to StoreMink to improve the guides.",
  emailSupport: "Email support",
  talkStatus: {
    starting: "Starting the microphone…",
    listening: "Listening… ask your question",
    transcribing: "Got it, one moment…",
    thinking: "Finding the answer…",
    speaking: "Speaking…",
  },
  skip: "Skip",
  skipLabel: "Stop speaking and listen",
  end: "End",
  endLabel: "End voice chat",
  voiceGroup: "Voice chat with Mink AI",
  dismiss: "Dismiss",
  stillAnswering: "Mink AI is still answering.",
  connectionError:
    "Mink AI couldn’t respond. Check your connection and try again.",
  copyError: "Couldn’t copy the answer. Select the text to copy it.",
  ratingError: "That rating couldn’t be saved.",
  phrases: {
    silence: "I didn't hear anything for a while, so I ended the voice chat.",
    unclear: "Sorry, I didn't catch a question there. Could you say it again?",
    sorry: "Sorry.",
    failed: "Mink AI couldn't respond just now.",
    hidden: "Voice chat ended because the page was hidden.",
    stopped: "Voice chat stopped. Try again, or type your question.",
    stepWord: "Step",
  },
};

const hi: MinkStrings = {
  subtitle: "Help गाइड से जवाब",
  dialogLabel: "Mink AI सहायक",
  introLead: "नमस्ते! मैं Mink AI हूँ।",
  welcomeTitle: "नमस्ते, मैं Mink AI हूँ",
  welcomeText:
    "बताइए आप क्या करना चाहते हैं, या StoreMink की जिस स्क्रीन पर आप अटके हैं उसके बारे में लिखिए। प्रकाशित Help Centre गाइड से आपको कदम-दर-कदम मदद मिलेगी।",
  examplesLabel: "उदाहरण सवाल",
  starters: [
    "मैं अपना पहला प्रोडक्ट कैसे जोड़ूँ?",
    "मैं अपना डोमेन कैसे जोड़ूँ?",
    "मैं POS सेल कैसे करूँ?",
    "मैं शिपिंग कैसे सेट करूँ?",
  ],
  inputLabel: "Mink AI से StoreMink के बारे में पूछें",
  placeholder: "कुछ भी पूछें…",
  placeholderTranscribing: "आपकी आवाज़ को टेक्स्ट में बदला जा रहा है…",
  hintKeys: "भेजने के लिए Enter · नई लाइन के लिए Shift + Enter",
  hintRecording: "सुना जा रहा है… पूरा होने पर हो गया दबाएँ",
  hintTranscribing: "टेक्स्ट में बदला जा रहा है…",
  dictate: "अपना सवाल बोलकर लिखवाएँ",
  talk: "Mink AI से बात करें",
  send: "सवाल भेजें",
  cancelDictation: "बोलकर लिखवाना रद्द करें",
  finishDictation: "बोलकर लिखवाना पूरा करें",
  done: "हो गया",
  newChat: "नई चैट",
  newChatLabel: "नई बातचीत शुरू करें",
  recentChats: "हाल की चैट",
  maximize: "Mink AI को पूरी स्क्रीन पर खोलें",
  restore: "Mink AI को साइड पैनल में लौटाएँ",
  close: "Mink AI बंद करें",
  back: "वापस",
  language: "भाषा",
  options: "विकल्प",
  recent: "हाल की",
  noRecent: "आपकी चैट यहाँ दिखेंगी।",
  savedHere: "सिर्फ़ इसी ब्राउज़र में सेव होती हैं।",
  deleteChat: "चैट हटाएँ",
  browseGuides: "सभी गाइड देखें",
  searchGuides: "गाइड में खोजें",
  saidAloud: "बोलकर पूछा",
  sourceGuides: "स्रोत गाइड",
  readFullGuide: "पूरी गाइड पढ़ें",
  important: "ज़रूरी",
  includeDetails: "अपने जवाब में ये जानकारी दें",
  thinking: "Help गाइड पढ़ी जा रही हैं…",
  thinkingLabel: "सबसे सही जवाब ढूँढा जा रहा है",
  copy: "जवाब कॉपी करें",
  copied: "कॉपी हो गया",
  listen: "यह जवाब सुनें",
  stopListening: "जवाब पढ़ना रोकें",
  helpful: "मददगार",
  notHelpful: "मददगार नहीं",
  thanks:
    "धन्यवाद। आपकी रेटिंग, आपका सवाल और यह जवाब गाइड बेहतर बनाने के लिए StoreMink को भेजे गए।",
  emailSupport: "सपोर्ट को ईमेल करें",
  talkStatus: {
    starting: "माइक्रोफ़ोन शुरू हो रहा है…",
    listening: "सुना जा रहा है… अपना सवाल पूछें",
    transcribing: "ठीक है, एक पल…",
    thinking: "जवाब ढूँढा जा रहा है…",
    speaking: "बोला जा रहा है…",
  },
  skip: "छोड़ें",
  skipLabel: "बोलना रोकें और सुनें",
  end: "खत्म करें",
  endLabel: "वॉइस चैट खत्म करें",
  voiceGroup: "Mink AI से वॉइस चैट",
  dismiss: "बंद करें",
  stillAnswering: "Mink AI का जवाब अभी आ रहा है।",
  connectionError:
    "Mink AI से जवाब नहीं मिल सका। अपना कनेक्शन जाँचें और फिर कोशिश करें।",
  copyError: "जवाब कॉपी नहीं हो सका। टेक्स्ट चुनकर कॉपी करें।",
  ratingError: "रेटिंग सेव नहीं हो सकी।",
  phrases: {
    silence: "काफ़ी देर तक कुछ सुनाई नहीं दिया, इसलिए वॉइस चैट बंद कर दी गई।",
    unclear: "माफ़ कीजिए, सवाल समझ नहीं आया। क्या आप फिर से बोल सकते हैं?",
    sorry: "माफ़ कीजिए।",
    failed: "अभी Mink AI से जवाब नहीं मिल सका।",
    hidden: "पेज छिप गया, इसलिए वॉइस चैट बंद हो गई।",
    stopped: "वॉइस चैट रुक गई। फिर कोशिश करें, या अपना सवाल लिखें।",
    stepWord: "चरण",
  },
};

const bn: MinkStrings = {
  subtitle: "Help গাইড থেকে উত্তর",
  dialogLabel: "Mink AI সহকারী",
  introLead: "নমস্কার! আমি Mink AI।",
  welcomeTitle: "নমস্কার, আমি Mink AI",
  welcomeText:
    "আপনি কী করতে চান বলুন, অথবা StoreMink-এর যে স্ক্রিনে আটকে আছেন তার কথা লিখুন। প্রকাশিত Help Centre গাইড থেকে আপনি ধাপে ধাপে সাহায্য পাবেন।",
  examplesLabel: "উদাহরণ প্রশ্ন",
  starters: [
    "আমার প্রথম পণ্য কীভাবে যোগ করব?",
    "আমার ডোমেন কীভাবে যুক্ত করব?",
    "POS বিক্রি কীভাবে করব?",
    "শিপিং কীভাবে সেট আপ করব?",
  ],
  inputLabel: "Mink AI-কে StoreMink নিয়ে প্রশ্ন করুন",
  placeholder: "যেকোনো কিছু জিজ্ঞাসা করুন…",
  placeholderTranscribing: "আপনার কথা লেখায় রূপান্তর করা হচ্ছে…",
  hintKeys: "পাঠাতে Enter · নতুন লাইনের জন্য Shift + Enter",
  hintRecording: "শোনা হচ্ছে… বলা শেষ হলে হয়েছে চাপুন",
  hintTranscribing: "লেখায় রূপান্তর করা হচ্ছে…",
  dictate: "আপনার প্রশ্ন বলে লিখুন",
  talk: "Mink AI-এর সঙ্গে কথা বলুন",
  send: "প্রশ্ন পাঠান",
  cancelDictation: "বলে লেখা বাতিল করুন",
  finishDictation: "বলে লেখা শেষ করুন",
  done: "হয়েছে",
  newChat: "নতুন চ্যাট",
  newChatLabel: "নতুন কথোপকথন শুরু করুন",
  recentChats: "সাম্প্রতিক চ্যাট",
  maximize: "Mink AI পুরো স্ক্রিনে খুলুন",
  restore: "Mink AI পাশের প্যানেলে ফেরান",
  close: "Mink AI বন্ধ করুন",
  back: "ফিরে যান",
  language: "ভাষা",
  options: "বিকল্প",
  recent: "সাম্প্রতিক",
  noRecent: "আপনার চ্যাট এখানে দেখা যাবে।",
  savedHere: "শুধু এই ব্রাউজারেই সেভ থাকে।",
  deleteChat: "চ্যাট মুছুন",
  browseGuides: "সব গাইড দেখুন",
  searchGuides: "গাইডে খুঁজুন",
  saidAloud: "বলে জিজ্ঞাসা করা",
  sourceGuides: "সূত্র গাইড",
  readFullGuide: "পুরো গাইড পড়ুন",
  important: "জরুরি",
  includeDetails: "আপনার উত্তরে এই তথ্যগুলো দিন",
  thinking: "Help গাইড পড়া হচ্ছে…",
  thinkingLabel: "সবচেয়ে ভালো উত্তর খোঁজা হচ্ছে",
  copy: "উত্তর কপি করুন",
  copied: "কপি হয়েছে",
  listen: "এই উত্তর শুনুন",
  stopListening: "উত্তর পড়া থামান",
  helpful: "সহায়ক",
  notHelpful: "সহায়ক নয়",
  thanks:
    "ধন্যবাদ। গাইড আরও ভালো করার জন্য আপনার রেটিং, আপনার প্রশ্ন আর এই উত্তর StoreMink-কে পাঠানো হয়েছে।",
  emailSupport: "সাপোর্টে ইমেল করুন",
  talkStatus: {
    starting: "মাইক্রোফোন চালু হচ্ছে…",
    listening: "শোনা হচ্ছে… আপনার প্রশ্ন বলুন",
    transcribing: "ঠিক আছে, এক মুহূর্ত…",
    thinking: "উত্তর খোঁজা হচ্ছে…",
    speaking: "বলা হচ্ছে…",
  },
  skip: "এড়িয়ে যান",
  skipLabel: "বলা থামিয়ে শুনুন",
  end: "শেষ করুন",
  endLabel: "ভয়েস চ্যাট শেষ করুন",
  voiceGroup: "Mink AI-এর সঙ্গে ভয়েস চ্যাট",
  dismiss: "বন্ধ করুন",
  stillAnswering: "Mink AI-এর উত্তর এখনও আসছে।",
  connectionError:
    "Mink AI থেকে উত্তর পাওয়া যায়নি। আপনার সংযোগ দেখে আবার চেষ্টা করুন।",
  copyError: "উত্তর কপি করা যায়নি। লেখাটি বেছে নিয়ে কপি করুন।",
  ratingError: "রেটিং সেভ করা যায়নি।",
  phrases: {
    silence: "অনেকক্ষণ কিছু শোনা যায়নি, তাই ভয়েস চ্যাট বন্ধ করা হলো।",
    unclear: "দুঃখিত, প্রশ্নটি বোঝা যায়নি। আবার বলবেন?",
    sorry: "দুঃখিত।",
    failed: "এখন Mink AI থেকে উত্তর পাওয়া যায়নি।",
    hidden: "পেজটি লুকানো হয়েছে, তাই ভয়েস চ্যাট বন্ধ হয়েছে।",
    stopped: "ভয়েস চ্যাট থেমে গেছে। আবার চেষ্টা করুন, অথবা প্রশ্নটি লিখুন।",
    stepWord: "ধাপ",
  },
};

const ta: MinkStrings = {
  subtitle: "Help வழிகாட்டிகளிலிருந்து பதில்கள்",
  dialogLabel: "Mink AI உதவியாளர்",
  introLead: "வணக்கம்! நான் Mink AI.",
  welcomeTitle: "வணக்கம், நான் Mink AI",
  welcomeText:
    "நீங்கள் என்ன செய்ய விரும்புகிறீர்கள் என்று சொல்லுங்கள், அல்லது StoreMink-இல் நீங்கள் சிக்கியுள்ள திரையை விவரியுங்கள். வெளியிடப்பட்ட Help Centre வழிகாட்டிகளிலிருந்து படிப்படியான உதவி கிடைக்கும்.",
  examplesLabel: "எடுத்துக்காட்டு கேள்விகள்",
  starters: [
    "என் முதல் தயாரிப்பை எப்படிச் சேர்ப்பது?",
    "என் டொமைனை எப்படி இணைப்பது?",
    "POS விற்பனையை எப்படிச் செய்வது?",
    "ஷிப்பிங்கை எப்படி அமைப்பது?",
  ],
  inputLabel: "StoreMink பற்றி Mink AI-இடம் கேளுங்கள்",
  placeholder: "எதையும் கேளுங்கள்…",
  placeholderTranscribing: "உங்கள் குரல் உரையாக மாற்றப்படுகிறது…",
  hintKeys: "அனுப்ப Enter · புதிய வரிக்கு Shift + Enter",
  hintRecording: "கேட்கப்படுகிறது… பேசி முடித்ததும் முடிந்தது அழுத்துங்கள்",
  hintTranscribing: "உரையாக மாற்றப்படுகிறது…",
  dictate: "உங்கள் கேள்வியைப் பேசி எழுதுங்கள்",
  talk: "Mink AI-உடன் பேசுங்கள்",
  send: "கேள்வியை அனுப்பு",
  cancelDictation: "பேசி எழுதுவதை ரத்துசெய்",
  finishDictation: "பேசி எழுதுவதை முடி",
  done: "முடிந்தது",
  newChat: "புதிய உரையாடல்",
  newChatLabel: "புதிய உரையாடலைத் தொடங்கு",
  recentChats: "சமீபத்திய உரையாடல்கள்",
  maximize: "Mink AI-ஐ முழுத் திரையில் திற",
  restore: "Mink AI-ஐ பக்கப் பலகைக்குத் திருப்பு",
  close: "Mink AI-ஐ மூடு",
  back: "பின்செல்",
  language: "மொழி",
  options: "விருப்பங்கள்",
  recent: "சமீபத்தியவை",
  noRecent: "உங்கள் உரையாடல்கள் இங்கே தோன்றும்.",
  savedHere: "இந்த உலாவியில் மட்டுமே சேமிக்கப்படும்.",
  deleteChat: "உரையாடலை நீக்கு",
  browseGuides: "அனைத்து வழிகாட்டிகளையும் பார்",
  searchGuides: "வழிகாட்டிகளில் தேடு",
  saidAloud: "பேசிக் கேட்டது",
  sourceGuides: "ஆதார வழிகாட்டிகள்",
  readFullGuide: "முழு வழிகாட்டியைப் படியுங்கள்",
  important: "முக்கியம்",
  includeDetails: "உங்கள் பதிலில் இந்த விவரங்களைச் சேருங்கள்",
  thinking: "Help வழிகாட்டிகள் படிக்கப்படுகின்றன…",
  thinkingLabel: "சிறந்த பதில் தேடப்படுகிறது",
  copy: "பதிலை நகலெடு",
  copied: "நகலெடுக்கப்பட்டது",
  listen: "இந்தப் பதிலைக் கேளுங்கள்",
  stopListening: "பதிலைப் படிப்பதை நிறுத்து",
  helpful: "உதவியாக இருந்தது",
  notHelpful: "உதவியாக இல்லை",
  thanks:
    "நன்றி. வழிகாட்டிகளை மேம்படுத்த உங்கள் மதிப்பீடு, உங்கள் கேள்வி மற்றும் இந்தப் பதில் StoreMink-க்கு அனுப்பப்பட்டன.",
  emailSupport: "ஆதரவுக்கு மின்னஞ்சல் அனுப்பு",
  talkStatus: {
    starting: "மைக்ரோஃபோன் தொடங்குகிறது…",
    listening: "கேட்கப்படுகிறது… உங்கள் கேள்வியைக் கேளுங்கள்",
    transcribing: "சரி, ஒரு நொடி…",
    thinking: "பதில் தேடப்படுகிறது…",
    speaking: "பேசப்படுகிறது…",
  },
  skip: "தவிர்",
  skipLabel: "பேசுவதை நிறுத்தி கேள்",
  end: "முடி",
  endLabel: "குரல் உரையாடலை முடி",
  voiceGroup: "Mink AI-உடன் குரல் உரையாடல்",
  dismiss: "மூடு",
  stillAnswering: "Mink AI இன்னும் பதிலளித்துக்கொண்டிருக்கிறது.",
  connectionError:
    "Mink AI-இடமிருந்து பதில் கிடைக்கவில்லை. உங்கள் இணைப்பைச் சரிபார்த்து மீண்டும் முயலுங்கள்.",
  copyError: "பதிலை நகலெடுக்க முடியவில்லை. உரையைத் தேர்ந்தெடுத்து நகலெடுங்கள்.",
  ratingError: "மதிப்பீட்டைச் சேமிக்க முடியவில்லை.",
  phrases: {
    silence:
      "நீண்ட நேரம் எதுவும் கேட்கவில்லை, எனவே குரல் உரையாடல் முடிக்கப்பட்டது.",
    unclear: "மன்னிக்கவும், கேள்வி புரியவில்லை. மீண்டும் சொல்ல முடியுமா?",
    sorry: "மன்னிக்கவும்.",
    failed: "இப்போது Mink AI-இடமிருந்து பதில் கிடைக்கவில்லை.",
    hidden: "பக்கம் மறைக்கப்பட்டதால் குரல் உரையாடல் முடிந்தது.",
    stopped:
      "குரல் உரையாடல் நின்றது. மீண்டும் முயலுங்கள், அல்லது உங்கள் கேள்வியை எழுதுங்கள்.",
    stepWord: "படி",
  },
};

const te: MinkStrings = {
  subtitle: "Help గైడ్‌ల నుండి సమాధానాలు",
  dialogLabel: "Mink AI సహాయం",
  introLead: "నమస్తే! నేను Mink AI.",
  welcomeTitle: "నమస్తే, నేను Mink AI",
  welcomeText:
    "మీరు ఏమి చేయాలనుకుంటున్నారో చెప్పండి, లేదా StoreMink లో మీరు ఇరుక్కుపోయిన స్క్రీన్ గురించి వివరించండి. ప్రచురించిన Help Centre గైడ్‌ల నుండి మీకు దశలవారీ సహాయం లభిస్తుంది.",
  examplesLabel: "ఉదాహరణ ప్రశ్నలు",
  starters: [
    "నా మొదటి ఉత్పత్తిని ఎలా జోడించాలి?",
    "నా డొమైన్‌ను ఎలా కనెక్ట్ చేయాలి?",
    "POS అమ్మకం ఎలా చేయాలి?",
    "షిప్పింగ్‌ను ఎలా సెటప్ చేయాలి?",
  ],
  inputLabel: "StoreMink గురించి Mink AI ని అడగండి",
  placeholder: "ఏదైనా అడగండి…",
  placeholderTranscribing: "మీ మాటలు టెక్స్ట్‌గా మారుతున్నాయి…",
  hintKeys: "పంపడానికి Enter · కొత్త లైన్ కోసం Shift + Enter",
  hintRecording: "వింటోంది… మాట్లాడటం అయ్యాక అయింది నొక్కండి",
  hintTranscribing: "టెక్స్ట్‌గా మారుస్తోంది…",
  dictate: "మీ ప్రశ్నను మాట్లాడి రాయండి",
  talk: "Mink AI తో మాట్లాడండి",
  send: "ప్రశ్న పంపండి",
  cancelDictation: "మాట్లాడి రాయడం రద్దు చేయండి",
  finishDictation: "మాట్లాడి రాయడం పూర్తి చేయండి",
  done: "అయింది",
  newChat: "కొత్త చాట్",
  newChatLabel: "కొత్త సంభాషణ ప్రారంభించండి",
  recentChats: "ఇటీవలి చాట్‌లు",
  maximize: "Mink AI ని పూర్తి స్క్రీన్‌లో తెరవండి",
  restore: "Mink AI ని పక్క ప్యానెల్‌కు తిరిగి తీసుకురండి",
  close: "Mink AI ని మూసివేయండి",
  back: "వెనుకకు",
  language: "భాష",
  options: "ఎంపికలు",
  recent: "ఇటీవలివి",
  noRecent: "మీ చాట్‌లు ఇక్కడ కనిపిస్తాయి.",
  savedHere: "ఈ బ్రౌజర్‌లో మాత్రమే సేవ్ అవుతాయి.",
  deleteChat: "చాట్‌ను తొలగించండి",
  browseGuides: "అన్ని గైడ్‌లు చూడండి",
  searchGuides: "గైడ్‌లలో వెతకండి",
  saidAloud: "మాట్లాడి అడిగారు",
  sourceGuides: "మూల గైడ్‌లు",
  readFullGuide: "పూర్తి గైడ్ చదవండి",
  important: "ముఖ్యం",
  includeDetails: "మీ సమాధానంలో ఈ వివరాలు ఇవ్వండి",
  thinking: "Help గైడ్‌లు చదువుతోంది…",
  thinkingLabel: "ఉత్తమ సమాధానం వెతుకుతోంది",
  copy: "సమాధానాన్ని కాపీ చేయండి",
  copied: "కాపీ అయింది",
  listen: "ఈ సమాధానం వినండి",
  stopListening: "సమాధానం చదవడం ఆపండి",
  helpful: "ఉపయోగపడింది",
  notHelpful: "ఉపయోగపడలేదు",
  thanks:
    "ధన్యవాదాలు. గైడ్‌లను మెరుగుపరచడానికి మీ రేటింగ్, మీ ప్రశ్న మరియు ఈ సమాధానం StoreMink కు పంపబడ్డాయి.",
  emailSupport: "సపోర్ట్‌కు ఈమెయిల్ చేయండి",
  talkStatus: {
    starting: "మైక్రోఫోన్ ప్రారంభమవుతోంది…",
    listening: "వింటోంది… మీ ప్రశ్న అడగండి",
    transcribing: "సరే, ఒక్క క్షణం…",
    thinking: "సమాధానం వెతుకుతోంది…",
    speaking: "మాట్లాడుతోంది…",
  },
  skip: "దాటవేయండి",
  skipLabel: "మాట్లాడటం ఆపి వినండి",
  end: "ముగించండి",
  endLabel: "వాయిస్ చాట్ ముగించండి",
  voiceGroup: "Mink AI తో వాయిస్ చాట్",
  dismiss: "మూసివేయండి",
  stillAnswering: "Mink AI ఇంకా సమాధానం ఇస్తోంది.",
  connectionError:
    "Mink AI నుండి సమాధానం రాలేదు. మీ కనెక్షన్‌ను తనిఖీ చేసి మళ్లీ ప్రయత్నించండి.",
  copyError: "సమాధానాన్ని కాపీ చేయలేకపోయాం. టెక్స్ట్‌ను ఎంచుకుని కాపీ చేయండి.",
  ratingError: "రేటింగ్ సేవ్ కాలేదు.",
  phrases: {
    silence: "చాలాసేపు ఏమీ వినిపించలేదు, కాబట్టి వాయిస్ చాట్ ముగించాం.",
    unclear: "క్షమించండి, ప్రశ్న అర్థం కాలేదు. మళ్లీ చెప్పగలరా?",
    sorry: "క్షమించండి.",
    failed: "ప్రస్తుతం Mink AI నుండి సమాధానం రాలేదు.",
    hidden: "పేజీ దాచబడినందున వాయిస్ చాట్ ముగిసింది.",
    stopped:
      "వాయిస్ చాట్ ఆగిపోయింది. మళ్లీ ప్రయత్నించండి, లేదా మీ ప్రశ్న రాయండి.",
    stepWord: "దశ",
  },
};

const mr: MinkStrings = {
  subtitle: "Help मार्गदर्शकांमधून उत्तरे",
  dialogLabel: "Mink AI सहाय्यक",
  introLead: "नमस्कार! मी Mink AI.",
  welcomeTitle: "नमस्कार, मी Mink AI",
  welcomeText:
    "तुम्हाला काय करायचे आहे ते सांगा, किंवा StoreMink च्या ज्या स्क्रीनवर तुम्ही अडकला आहात त्याबद्दल लिहा. प्रकाशित Help Centre मार्गदर्शकांमधून तुम्हाला टप्प्याटप्प्याने मदत मिळेल.",
  examplesLabel: "उदाहरण प्रश्न",
  starters: [
    "माझे पहिले उत्पादन कसे जोडू?",
    "माझे डोमेन कसे जोडू?",
    "POS विक्री कशी करू?",
    "शिपिंग कसे सेट करू?",
  ],
  inputLabel: "Mink AI ला StoreMink बद्दल विचारा",
  placeholder: "काहीही विचारा…",
  placeholderTranscribing: "तुमचा आवाज मजकुरात बदलत आहे…",
  hintKeys: "पाठवण्यासाठी Enter · नवीन ओळीसाठी Shift + Enter",
  hintRecording: "ऐकत आहे… बोलून झाल्यावर झाले दाबा",
  hintTranscribing: "मजकुरात बदलत आहे…",
  dictate: "तुमचा प्रश्न बोलून लिहा",
  talk: "Mink AI शी बोला",
  send: "प्रश्न पाठवा",
  cancelDictation: "बोलून लिहिणे रद्द करा",
  finishDictation: "बोलून लिहिणे पूर्ण करा",
  done: "झाले",
  newChat: "नवीन चॅट",
  newChatLabel: "नवीन संभाषण सुरू करा",
  recentChats: "अलीकडील चॅट",
  maximize: "Mink AI पूर्ण स्क्रीनवर उघडा",
  restore: "Mink AI बाजूच्या पॅनेलमध्ये परत आणा",
  close: "Mink AI बंद करा",
  back: "मागे",
  language: "भाषा",
  options: "पर्याय",
  recent: "अलीकडील",
  noRecent: "तुमच्या चॅट येथे दिसतील.",
  savedHere: "फक्त याच ब्राउझरमध्ये सेव्ह होतात.",
  deleteChat: "चॅट हटवा",
  browseGuides: "सर्व मार्गदर्शक पाहा",
  searchGuides: "मार्गदर्शकांमध्ये शोधा",
  saidAloud: "बोलून विचारले",
  sourceGuides: "स्रोत मार्गदर्शक",
  readFullGuide: "पूर्ण मार्गदर्शक वाचा",
  important: "महत्त्वाचे",
  includeDetails: "तुमच्या उत्तरात ही माहिती द्या",
  thinking: "Help मार्गदर्शक वाचत आहे…",
  thinkingLabel: "सर्वोत्तम उत्तर शोधत आहे",
  copy: "उत्तर कॉपी करा",
  copied: "कॉपी झाले",
  listen: "हे उत्तर ऐका",
  stopListening: "उत्तर वाचणे थांबवा",
  helpful: "उपयुक्त",
  notHelpful: "उपयुक्त नाही",
  thanks:
    "धन्यवाद. तुमचे रेटिंग, तुमचा प्रश्न आणि हे उत्तर मार्गदर्शक सुधारण्यासाठी StoreMink कडे पाठवले गेले.",
  emailSupport: "सपोर्टला ईमेल करा",
  talkStatus: {
    starting: "मायक्रोफोन सुरू होत आहे…",
    listening: "ऐकत आहे… तुमचा प्रश्न विचारा",
    transcribing: "ठीक आहे, एक क्षण…",
    thinking: "उत्तर शोधत आहे…",
    speaking: "बोलत आहे…",
  },
  skip: "वगळा",
  skipLabel: "बोलणे थांबवा आणि ऐका",
  end: "संपवा",
  endLabel: "व्हॉइस चॅट संपवा",
  voiceGroup: "Mink AI शी व्हॉइस चॅट",
  dismiss: "बंद करा",
  stillAnswering: "Mink AI चे उत्तर अजून येत आहे.",
  connectionError:
    "Mink AI कडून उत्तर मिळू शकले नाही. तुमचे कनेक्शन तपासा आणि पुन्हा प्रयत्न करा.",
  copyError: "उत्तर कॉपी होऊ शकले नाही. मजकूर निवडून कॉपी करा.",
  ratingError: "रेटिंग सेव्ह होऊ शकले नाही.",
  phrases: {
    silence: "बराच वेळ काहीही ऐकू आले नाही, म्हणून व्हॉइस चॅट बंद केला.",
    unclear: "माफ करा, प्रश्न समजला नाही. पुन्हा सांगाल का?",
    sorry: "माफ करा.",
    failed: "आत्ता Mink AI कडून उत्तर मिळू शकले नाही.",
    hidden: "पेज लपवले गेले, म्हणून व्हॉइस चॅट बंद झाला.",
    stopped: "व्हॉइस चॅट थांबला. पुन्हा प्रयत्न करा, किंवा तुमचा प्रश्न लिहा.",
    stepWord: "पायरी",
  },
};

const gu: MinkStrings = {
  subtitle: "Help માર્ગદર્શિકાઓમાંથી જવાબો",
  dialogLabel: "Mink AI સહાયક",
  introLead: "નમસ્તે! હું Mink AI છું.",
  welcomeTitle: "નમસ્તે, હું Mink AI છું",
  welcomeText:
    "તમે શું કરવા માંગો છો તે કહો, અથવા StoreMink ની જે સ્ક્રીન પર તમે અટક્યા છો તેના વિશે લખો. પ્રકાશિત Help Centre માર્ગદર્શિકાઓમાંથી તમને પગલું-દર-પગલું મદદ મળશે.",
  examplesLabel: "ઉદાહરણ પ્રશ્નો",
  starters: [
    "મારું પહેલું ઉત્પાદન કેવી રીતે ઉમેરું?",
    "મારું ડોમેન કેવી રીતે જોડું?",
    "POS વેચાણ કેવી રીતે કરું?",
    "શિપિંગ કેવી રીતે સેટ કરું?",
  ],
  inputLabel: "StoreMink વિશે Mink AI ને પૂછો",
  placeholder: "કંઈપણ પૂછો…",
  placeholderTranscribing: "તમારો અવાજ લખાણમાં બદલાઈ રહ્યો છે…",
  hintKeys: "મોકલવા Enter · નવી લાઇન માટે Shift + Enter",
  hintRecording: "સાંભળી રહ્યું છે… બોલવાનું પૂરું થાય ત્યારે થઈ ગયું દબાવો",
  hintTranscribing: "લખાણમાં બદલાઈ રહ્યું છે…",
  dictate: "તમારો પ્રશ્ન બોલીને લખાવો",
  talk: "Mink AI સાથે વાત કરો",
  send: "પ્રશ્ન મોકલો",
  cancelDictation: "બોલીને લખાવવાનું રદ કરો",
  finishDictation: "બોલીને લખાવવાનું પૂરું કરો",
  done: "થઈ ગયું",
  newChat: "નવી ચેટ",
  newChatLabel: "નવી વાતચીત શરૂ કરો",
  recentChats: "તાજેતરની ચેટ",
  maximize: "Mink AI ને પૂરી સ્ક્રીન પર ખોલો",
  restore: "Mink AI ને બાજુની પેનલમાં પાછું લાવો",
  close: "Mink AI બંધ કરો",
  back: "પાછા",
  language: "ભાષા",
  options: "વિકલ્પો",
  recent: "તાજેતરની",
  noRecent: "તમારી ચેટ અહીં દેખાશે.",
  savedHere: "ફક્ત આ બ્રાઉઝરમાં જ સેવ થાય છે.",
  deleteChat: "ચેટ કાઢી નાખો",
  browseGuides: "બધી માર્ગદર્શિકાઓ જુઓ",
  searchGuides: "માર્ગદર્શિકાઓમાં શોધો",
  saidAloud: "બોલીને પૂછ્યું",
  sourceGuides: "સ્રોત માર્ગદર્શિકાઓ",
  readFullGuide: "પૂરી માર્ગદર્શિકા વાંચો",
  important: "મહત્વનું",
  includeDetails: "તમારા જવાબમાં આ વિગતો આપો",
  thinking: "Help માર્ગદર્શિકાઓ વાંચી રહ્યું છે…",
  thinkingLabel: "શ્રેષ્ઠ જવાબ શોધી રહ્યું છે",
  copy: "જવાબ કૉપિ કરો",
  copied: "કૉપિ થઈ ગયું",
  listen: "આ જવાબ સાંભળો",
  stopListening: "જવાબ વાંચવાનું બંધ કરો",
  helpful: "ઉપયોગી",
  notHelpful: "ઉપયોગી નથી",
  thanks:
    "આભાર. માર્ગદર્શિકાઓ સુધારવા માટે તમારું રેટિંગ, તમારો પ્રશ્ન અને આ જવાબ StoreMink ને મોકલવામાં આવ્યા.",
  emailSupport: "સપોર્ટને ઇમેઇલ કરો",
  talkStatus: {
    starting: "માઇક્રોફોન શરૂ થઈ રહ્યું છે…",
    listening: "સાંભળી રહ્યું છે… તમારો પ્રશ્ન પૂછો",
    transcribing: "બરાબર, એક ક્ષણ…",
    thinking: "જવાબ શોધી રહ્યું છે…",
    speaking: "બોલી રહ્યું છે…",
  },
  skip: "છોડો",
  skipLabel: "બોલવાનું બંધ કરો અને સાંભળો",
  end: "પૂરું કરો",
  endLabel: "વૉઇસ ચેટ પૂરી કરો",
  voiceGroup: "Mink AI સાથે વૉઇસ ચેટ",
  dismiss: "બંધ કરો",
  stillAnswering: "Mink AI હજુ જવાબ આપી રહ્યું છે.",
  connectionError:
    "Mink AI તરફથી જવાબ મળી શક્યો નહીં. તમારું કનેક્શન તપાસો અને ફરી પ્રયાસ કરો.",
  copyError: "જવાબ કૉપિ થઈ શક્યો નહીં. લખાણ પસંદ કરીને કૉપિ કરો.",
  ratingError: "રેટિંગ સેવ થઈ શક્યું નહીં.",
  phrases: {
    silence: "ઘણા સમય સુધી કંઈ સંભળાયું નહીં, તેથી વૉઇસ ચેટ બંધ કરી.",
    unclear: "માફ કરશો, પ્રશ્ન સમજાયો નહીં. ફરીથી કહેશો?",
    sorry: "માફ કરશો.",
    failed: "અત્યારે Mink AI તરફથી જવાબ મળી શક્યો નહીં.",
    hidden: "પેજ છુપાઈ ગયું, તેથી વૉઇસ ચેટ બંધ થઈ.",
    stopped: "વૉઇસ ચેટ અટકી ગઈ. ફરી પ્રયાસ કરો, અથવા તમારો પ્રશ્ન લખો.",
    stepWord: "પગલું",
  },
};

const kn: MinkStrings = {
  subtitle: "Help ಮಾರ್ಗದರ್ಶಿಗಳಿಂದ ಉತ್ತರಗಳು",
  dialogLabel: "Mink AI ಸಹಾಯಕ",
  introLead: "ನಮಸ್ಕಾರ! ನಾನು Mink AI.",
  welcomeTitle: "ನಮಸ್ಕಾರ, ನಾನು Mink AI",
  welcomeText:
    "ನೀವು ಏನು ಮಾಡಲು ಬಯಸುತ್ತೀರಿ ಎಂದು ಹೇಳಿ, ಅಥವಾ StoreMink ನಲ್ಲಿ ನೀವು ಸಿಲುಕಿರುವ ಪರದೆಯ ಬಗ್ಗೆ ವಿವರಿಸಿ. ಪ್ರಕಟಿತ Help Centre ಮಾರ್ಗದರ್ಶಿಗಳಿಂದ ನಿಮಗೆ ಹಂತ ಹಂತವಾದ ಸಹಾಯ ಸಿಗುತ್ತದೆ.",
  examplesLabel: "ಉದಾಹರಣೆ ಪ್ರಶ್ನೆಗಳು",
  starters: [
    "ನನ್ನ ಮೊದಲ ಉತ್ಪನ್ನವನ್ನು ಹೇಗೆ ಸೇರಿಸುವುದು?",
    "ನನ್ನ ಡೊಮೇನ್ ಅನ್ನು ಹೇಗೆ ಸಂಪರ್ಕಿಸುವುದು?",
    "POS ಮಾರಾಟ ಹೇಗೆ ಮಾಡುವುದು?",
    "ಶಿಪ್ಪಿಂಗ್ ಅನ್ನು ಹೇಗೆ ಹೊಂದಿಸುವುದು?",
  ],
  inputLabel: "StoreMink ಬಗ್ಗೆ Mink AI ಅನ್ನು ಕೇಳಿ",
  placeholder: "ಏನನ್ನಾದರೂ ಕೇಳಿ…",
  placeholderTranscribing: "ನಿಮ್ಮ ಧ್ವನಿಯನ್ನು ಪಠ್ಯಕ್ಕೆ ಬದಲಾಯಿಸಲಾಗುತ್ತಿದೆ…",
  hintKeys: "ಕಳುಹಿಸಲು Enter · ಹೊಸ ಸಾಲಿಗೆ Shift + Enter",
  hintRecording: "ಕೇಳಲಾಗುತ್ತಿದೆ… ಮಾತನಾಡಿ ಮುಗಿದಾಗ ಆಯಿತು ಒತ್ತಿ",
  hintTranscribing: "ಪಠ್ಯಕ್ಕೆ ಬದಲಾಯಿಸಲಾಗುತ್ತಿದೆ…",
  dictate: "ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಮಾತನಾಡಿ ಬರೆಸಿ",
  talk: "Mink AI ಜೊತೆ ಮಾತನಾಡಿ",
  send: "ಪ್ರಶ್ನೆ ಕಳುಹಿಸಿ",
  cancelDictation: "ಮಾತನಾಡಿ ಬರೆಸುವುದನ್ನು ರದ್ದುಮಾಡಿ",
  finishDictation: "ಮಾತನಾಡಿ ಬರೆಸುವುದನ್ನು ಮುಗಿಸಿ",
  done: "ಆಯಿತು",
  newChat: "ಹೊಸ ಚಾಟ್",
  newChatLabel: "ಹೊಸ ಸಂಭಾಷಣೆ ಆರಂಭಿಸಿ",
  recentChats: "ಇತ್ತೀಚಿನ ಚಾಟ್‌ಗಳು",
  maximize: "Mink AI ಅನ್ನು ಪೂರ್ಣ ಪರದೆಯಲ್ಲಿ ತೆರೆಯಿರಿ",
  restore: "Mink AI ಅನ್ನು ಪಕ್ಕದ ಫಲಕಕ್ಕೆ ಹಿಂತಿರುಗಿಸಿ",
  close: "Mink AI ಮುಚ್ಚಿ",
  back: "ಹಿಂದೆ",
  language: "ಭಾಷೆ",
  options: "ಆಯ್ಕೆಗಳು",
  recent: "ಇತ್ತೀಚಿನವು",
  noRecent: "ನಿಮ್ಮ ಚಾಟ್‌ಗಳು ಇಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ.",
  savedHere: "ಈ ಬ್ರೌಸರ್‌ನಲ್ಲಿ ಮಾತ್ರ ಉಳಿಸಲಾಗುತ್ತದೆ.",
  deleteChat: "ಚಾಟ್ ಅಳಿಸಿ",
  browseGuides: "ಎಲ್ಲ ಮಾರ್ಗದರ್ಶಿಗಳನ್ನು ನೋಡಿ",
  searchGuides: "ಮಾರ್ಗದರ್ಶಿಗಳಲ್ಲಿ ಹುಡುಕಿ",
  saidAloud: "ಮಾತನಾಡಿ ಕೇಳಿದ್ದು",
  sourceGuides: "ಮೂಲ ಮಾರ್ಗದರ್ಶಿಗಳು",
  readFullGuide: "ಪೂರ್ಣ ಮಾರ್ಗದರ್ಶಿ ಓದಿ",
  important: "ಮುಖ್ಯ",
  includeDetails: "ನಿಮ್ಮ ಉತ್ತರದಲ್ಲಿ ಈ ವಿವರಗಳನ್ನು ನೀಡಿ",
  thinking: "Help ಮಾರ್ಗದರ್ಶಿಗಳನ್ನು ಓದಲಾಗುತ್ತಿದೆ…",
  thinkingLabel: "ಉತ್ತಮ ಉತ್ತರ ಹುಡುಕಲಾಗುತ್ತಿದೆ",
  copy: "ಉತ್ತರ ನಕಲಿಸಿ",
  copied: "ನಕಲಿಸಲಾಗಿದೆ",
  listen: "ಈ ಉತ್ತರ ಕೇಳಿ",
  stopListening: "ಉತ್ತರ ಓದುವುದನ್ನು ನಿಲ್ಲಿಸಿ",
  helpful: "ಉಪಯುಕ್ತ",
  notHelpful: "ಉಪಯುಕ್ತವಲ್ಲ",
  thanks:
    "ಧನ್ಯವಾದಗಳು. ಮಾರ್ಗದರ್ಶಿಗಳನ್ನು ಸುಧಾರಿಸಲು ನಿಮ್ಮ ರೇಟಿಂಗ್, ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಮತ್ತು ಈ ಉತ್ತರವನ್ನು StoreMink ಗೆ ಕಳುಹಿಸಲಾಗಿದೆ.",
  emailSupport: "ಸಪೋರ್ಟ್‌ಗೆ ಇಮೇಲ್ ಮಾಡಿ",
  talkStatus: {
    starting: "ಮೈಕ್ರೋಫೋನ್ ಆರಂಭವಾಗುತ್ತಿದೆ…",
    listening: "ಕೇಳಲಾಗುತ್ತಿದೆ… ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಕೇಳಿ",
    transcribing: "ಸರಿ, ಒಂದು ಕ್ಷಣ…",
    thinking: "ಉತ್ತರ ಹುಡುಕಲಾಗುತ್ತಿದೆ…",
    speaking: "ಮಾತನಾಡಲಾಗುತ್ತಿದೆ…",
  },
  skip: "ಬಿಟ್ಟುಬಿಡಿ",
  skipLabel: "ಮಾತು ನಿಲ್ಲಿಸಿ ಕೇಳಿ",
  end: "ಮುಗಿಸಿ",
  endLabel: "ಧ್ವನಿ ಚಾಟ್ ಮುಗಿಸಿ",
  voiceGroup: "Mink AI ಜೊತೆ ಧ್ವನಿ ಚಾಟ್",
  dismiss: "ಮುಚ್ಚಿ",
  stillAnswering: "Mink AI ಇನ್ನೂ ಉತ್ತರಿಸುತ್ತಿದೆ.",
  connectionError:
    "Mink AI ಯಿಂದ ಉತ್ತರ ಸಿಗಲಿಲ್ಲ. ನಿಮ್ಮ ಸಂಪರ್ಕವನ್ನು ಪರಿಶೀಲಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
  copyError: "ಉತ್ತರವನ್ನು ನಕಲಿಸಲಾಗಲಿಲ್ಲ. ಪಠ್ಯವನ್ನು ಆಯ್ಕೆಮಾಡಿ ನಕಲಿಸಿ.",
  ratingError: "ರೇಟಿಂಗ್ ಉಳಿಸಲಾಗಲಿಲ್ಲ.",
  phrases: {
    silence: "ಬಹಳ ಹೊತ್ತು ಏನೂ ಕೇಳಿಸಲಿಲ್ಲ, ಆದ್ದರಿಂದ ಧ್ವನಿ ಚಾಟ್ ಮುಗಿಸಲಾಯಿತು.",
    unclear: "ಕ್ಷಮಿಸಿ, ಪ್ರಶ್ನೆ ಅರ್ಥವಾಗಲಿಲ್ಲ. ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?",
    sorry: "ಕ್ಷಮಿಸಿ.",
    failed: "ಈಗ Mink AI ಯಿಂದ ಉತ್ತರ ಸಿಗಲಿಲ್ಲ.",
    hidden: "ಪುಟ ಮರೆಯಾದ ಕಾರಣ ಧ್ವನಿ ಚಾಟ್ ಮುಗಿಯಿತು.",
    stopped:
      "ಧ್ವನಿ ಚಾಟ್ ನಿಂತಿತು. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ, ಅಥವಾ ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಬರೆಯಿರಿ.",
    stepWord: "ಹಂತ",
  },
};

const pa: MinkStrings = {
  subtitle: "Help ਗਾਈਡਾਂ ਤੋਂ ਜਵਾਬ",
  dialogLabel: "Mink AI ਸਹਾਇਕ",
  introLead: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ Mink AI ਹਾਂ।",
  welcomeTitle: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ Mink AI ਹਾਂ",
  welcomeText:
    "ਦੱਸੋ ਤੁਸੀਂ ਕੀ ਕਰਨਾ ਚਾਹੁੰਦੇ ਹੋ, ਜਾਂ StoreMink ਦੀ ਜਿਸ ਸਕ੍ਰੀਨ 'ਤੇ ਤੁਸੀਂ ਅਟਕੇ ਹੋ ਉਸ ਬਾਰੇ ਲਿਖੋ। ਪ੍ਰਕਾਸ਼ਿਤ Help Centre ਗਾਈਡਾਂ ਤੋਂ ਤੁਹਾਨੂੰ ਕਦਮ-ਦਰ-ਕਦਮ ਮਦਦ ਮਿਲੇਗੀ।",
  examplesLabel: "ਉਦਾਹਰਣ ਸਵਾਲ",
  starters: [
    "ਮੈਂ ਆਪਣਾ ਪਹਿਲਾ ਉਤਪਾਦ ਕਿਵੇਂ ਜੋੜਾਂ?",
    "ਮੈਂ ਆਪਣਾ ਡੋਮੇਨ ਕਿਵੇਂ ਜੋੜਾਂ?",
    "ਮੈਂ POS ਵਿਕਰੀ ਕਿਵੇਂ ਕਰਾਂ?",
    "ਮੈਂ ਸ਼ਿਪਿੰਗ ਕਿਵੇਂ ਸੈੱਟ ਕਰਾਂ?",
  ],
  inputLabel: "StoreMink ਬਾਰੇ Mink AI ਨੂੰ ਪੁੱਛੋ",
  placeholder: "ਕੁਝ ਵੀ ਪੁੱਛੋ…",
  placeholderTranscribing: "ਤੁਹਾਡੀ ਆਵਾਜ਼ ਨੂੰ ਲਿਖਤ ਵਿੱਚ ਬਦਲਿਆ ਜਾ ਰਿਹਾ ਹੈ…",
  hintKeys: "ਭੇਜਣ ਲਈ Enter · ਨਵੀਂ ਲਾਈਨ ਲਈ Shift + Enter",
  hintRecording: "ਸੁਣਿਆ ਜਾ ਰਿਹਾ ਹੈ… ਬੋਲਣਾ ਪੂਰਾ ਹੋਣ 'ਤੇ ਹੋ ਗਿਆ ਦਬਾਓ",
  hintTranscribing: "ਲਿਖਤ ਵਿੱਚ ਬਦਲਿਆ ਜਾ ਰਿਹਾ ਹੈ…",
  dictate: "ਆਪਣਾ ਸਵਾਲ ਬੋਲ ਕੇ ਲਿਖਵਾਓ",
  talk: "Mink AI ਨਾਲ ਗੱਲ ਕਰੋ",
  send: "ਸਵਾਲ ਭੇਜੋ",
  cancelDictation: "ਬੋਲ ਕੇ ਲਿਖਵਾਉਣਾ ਰੱਦ ਕਰੋ",
  finishDictation: "ਬੋਲ ਕੇ ਲਿਖਵਾਉਣਾ ਪੂਰਾ ਕਰੋ",
  done: "ਹੋ ਗਿਆ",
  newChat: "ਨਵੀਂ ਚੈਟ",
  newChatLabel: "ਨਵੀਂ ਗੱਲਬਾਤ ਸ਼ੁਰੂ ਕਰੋ",
  recentChats: "ਹਾਲੀਆ ਚੈਟਾਂ",
  maximize: "Mink AI ਨੂੰ ਪੂਰੀ ਸਕ੍ਰੀਨ 'ਤੇ ਖੋਲ੍ਹੋ",
  restore: "Mink AI ਨੂੰ ਪਾਸੇ ਵਾਲੇ ਪੈਨਲ ਵਿੱਚ ਵਾਪਸ ਲਿਆਓ",
  close: "Mink AI ਬੰਦ ਕਰੋ",
  back: "ਵਾਪਸ",
  language: "ਭਾਸ਼ਾ",
  options: "ਵਿਕਲਪ",
  recent: "ਹਾਲੀਆ",
  noRecent: "ਤੁਹਾਡੀਆਂ ਚੈਟਾਂ ਇੱਥੇ ਦਿਖਣਗੀਆਂ।",
  savedHere: "ਸਿਰਫ਼ ਇਸੇ ਬ੍ਰਾਊਜ਼ਰ ਵਿੱਚ ਸੇਵ ਹੁੰਦੀਆਂ ਹਨ।",
  deleteChat: "ਚੈਟ ਮਿਟਾਓ",
  browseGuides: "ਸਾਰੀਆਂ ਗਾਈਡਾਂ ਦੇਖੋ",
  searchGuides: "ਗਾਈਡਾਂ ਵਿੱਚ ਖੋਜੋ",
  saidAloud: "ਬੋਲ ਕੇ ਪੁੱਛਿਆ",
  sourceGuides: "ਸਰੋਤ ਗਾਈਡਾਂ",
  readFullGuide: "ਪੂਰੀ ਗਾਈਡ ਪੜ੍ਹੋ",
  important: "ਜ਼ਰੂਰੀ",
  includeDetails: "ਆਪਣੇ ਜਵਾਬ ਵਿੱਚ ਇਹ ਜਾਣਕਾਰੀ ਦਿਓ",
  thinking: "Help ਗਾਈਡਾਂ ਪੜ੍ਹੀਆਂ ਜਾ ਰਹੀਆਂ ਹਨ…",
  thinkingLabel: "ਸਭ ਤੋਂ ਵਧੀਆ ਜਵਾਬ ਲੱਭਿਆ ਜਾ ਰਿਹਾ ਹੈ",
  copy: "ਜਵਾਬ ਕਾਪੀ ਕਰੋ",
  copied: "ਕਾਪੀ ਹੋ ਗਿਆ",
  listen: "ਇਹ ਜਵਾਬ ਸੁਣੋ",
  stopListening: "ਜਵਾਬ ਪੜ੍ਹਨਾ ਬੰਦ ਕਰੋ",
  helpful: "ਮਦਦਗਾਰ",
  notHelpful: "ਮਦਦਗਾਰ ਨਹੀਂ",
  thanks:
    "ਧੰਨਵਾਦ। ਗਾਈਡਾਂ ਬਿਹਤਰ ਬਣਾਉਣ ਲਈ ਤੁਹਾਡੀ ਰੇਟਿੰਗ, ਤੁਹਾਡਾ ਸਵਾਲ ਅਤੇ ਇਹ ਜਵਾਬ StoreMink ਨੂੰ ਭੇਜੇ ਗਏ।",
  emailSupport: "ਸਪੋਰਟ ਨੂੰ ਈਮੇਲ ਕਰੋ",
  talkStatus: {
    starting: "ਮਾਈਕ੍ਰੋਫ਼ੋਨ ਸ਼ੁਰੂ ਹੋ ਰਿਹਾ ਹੈ…",
    listening: "ਸੁਣਿਆ ਜਾ ਰਿਹਾ ਹੈ… ਆਪਣਾ ਸਵਾਲ ਪੁੱਛੋ",
    transcribing: "ਠੀਕ ਹੈ, ਇੱਕ ਪਲ…",
    thinking: "ਜਵਾਬ ਲੱਭਿਆ ਜਾ ਰਿਹਾ ਹੈ…",
    speaking: "ਬੋਲਿਆ ਜਾ ਰਿਹਾ ਹੈ…",
  },
  skip: "ਛੱਡੋ",
  skipLabel: "ਬੋਲਣਾ ਰੋਕੋ ਅਤੇ ਸੁਣੋ",
  end: "ਖਤਮ ਕਰੋ",
  endLabel: "ਵੌਇਸ ਚੈਟ ਖਤਮ ਕਰੋ",
  voiceGroup: "Mink AI ਨਾਲ ਵੌਇਸ ਚੈਟ",
  dismiss: "ਬੰਦ ਕਰੋ",
  stillAnswering: "Mink AI ਦਾ ਜਵਾਬ ਅਜੇ ਆ ਰਿਹਾ ਹੈ।",
  connectionError:
    "Mink AI ਤੋਂ ਜਵਾਬ ਨਹੀਂ ਮਿਲ ਸਕਿਆ। ਆਪਣਾ ਕਨੈਕਸ਼ਨ ਜਾਂਚੋ ਅਤੇ ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
  copyError: "ਜਵਾਬ ਕਾਪੀ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਲਿਖਤ ਚੁਣ ਕੇ ਕਾਪੀ ਕਰੋ।",
  ratingError: "ਰੇਟਿੰਗ ਸੇਵ ਨਹੀਂ ਹੋ ਸਕੀ।",
  phrases: {
    silence: "ਕਾਫ਼ੀ ਦੇਰ ਤੱਕ ਕੁਝ ਸੁਣਾਈ ਨਹੀਂ ਦਿੱਤਾ, ਇਸ ਲਈ ਵੌਇਸ ਚੈਟ ਬੰਦ ਕਰ ਦਿੱਤੀ।",
    unclear: "ਮਾਫ਼ ਕਰਨਾ, ਸਵਾਲ ਸਮਝ ਨਹੀਂ ਆਇਆ। ਕੀ ਤੁਸੀਂ ਦੁਬਾਰਾ ਦੱਸ ਸਕਦੇ ਹੋ?",
    sorry: "ਮਾਫ਼ ਕਰਨਾ।",
    failed: "ਹੁਣੇ Mink AI ਤੋਂ ਜਵਾਬ ਨਹੀਂ ਮਿਲ ਸਕਿਆ।",
    hidden: "ਪੰਨਾ ਲੁਕ ਗਿਆ, ਇਸ ਲਈ ਵੌਇਸ ਚੈਟ ਬੰਦ ਹੋ ਗਈ।",
    stopped: "ਵੌਇਸ ਚੈਟ ਰੁਕ ਗਈ। ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ, ਜਾਂ ਆਪਣਾ ਸਵਾਲ ਲਿਖੋ।",
    stepWord: "ਕਦਮ",
  },
};

export const MINK_STRINGS: Record<HelpLanguageCode, MinkStrings> = {
  en,
  hi,
  bn,
  ta,
  te,
  mr,
  gu,
  kn,
  pa,
};

/** The chat's words for a language; English when none is picked, or when a
 *  code reaches here unchecked (a stale saved value). */
export function minkStrings(code: HelpLanguageCode | null): MinkStrings {
  return (code && MINK_STRINGS[code]) || MINK_STRINGS.en;
}

/** The first message every conversation starts from, in the chat's words. */
export function minkIntro(strings: MinkStrings): string {
  return `${strings.introLead} ${strings.welcomeText}`;
}
