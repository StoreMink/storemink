// The languages the Help Centre's Mink AI chat offers in its language menu,
// shared by the chat (its words and the reply language it asks for) and by
// the public assistant action (which validates the code and tells the model
// which language to answer in). Pure: no I/O, safe on the client.
//
// ★ CHOOSING A LANGUAGE IS EXPLICIT. Until a visitor picks one, the chat
// shows English words and Mink AI answers in the language the visitor types
// in (the behaviour before the menu existed). Once a language is picked, the
// chat's words change to it and every answer is written in it, whatever
// language the question was typed in.

export const HELP_LANGUAGES = [
  {
    code: "en",
    name: "English",
    native: "English",
    speech: "en-IN",
    model: "English",
  },
  {
    code: "hi",
    name: "Hindi",
    native: "हिन्दी",
    speech: "hi-IN",
    model: "Hindi, written in Devanagari script",
  },
  {
    code: "bn",
    name: "Bengali",
    native: "বাংলা",
    speech: "bn-IN",
    model: "Bengali (Bangla), written in Bengali script",
  },
  {
    code: "ta",
    name: "Tamil",
    native: "தமிழ்",
    speech: "ta-IN",
    model: "Tamil, written in Tamil script",
  },
  {
    code: "te",
    name: "Telugu",
    native: "తెలుగు",
    speech: "te-IN",
    model: "Telugu, written in Telugu script",
  },
  {
    code: "mr",
    name: "Marathi",
    native: "मराठी",
    speech: "mr-IN",
    model: "Marathi, written in Devanagari script",
  },
  {
    code: "gu",
    name: "Gujarati",
    native: "ગુજરાતી",
    speech: "gu-IN",
    model: "Gujarati, written in Gujarati script",
  },
  {
    code: "kn",
    name: "Kannada",
    native: "ಕನ್ನಡ",
    speech: "kn-IN",
    model: "Kannada, written in Kannada script",
  },
  {
    code: "pa",
    name: "Punjabi",
    native: "ਪੰਜਾਬੀ",
    speech: "pa-IN",
    model: "Punjabi, written in Gurmukhi script",
  },
] as const;

export type HelpLanguage = (typeof HELP_LANGUAGES)[number];
export type HelpLanguageCode = HelpLanguage["code"];

export const DEFAULT_HELP_LANGUAGE: HelpLanguageCode = "en";

const BY_CODE = new Map<string, HelpLanguage>(
  HELP_LANGUAGES.map((language) => [language.code, language]),
);

export function isHelpLanguageCode(value: unknown): value is HelpLanguageCode {
  return typeof value === "string" && BY_CODE.has(value);
}

/** The language for a code; English for anything unknown. */
export function helpLanguage(code: unknown): HelpLanguage {
  return (
    (typeof code === "string" ? BY_CODE.get(code) : undefined) ??
    HELP_LANGUAGES[0]
  );
}

/**
 * The words an answer falls back to when the model cannot answer, in the
 * language the visitor chose. English is the text the assistant has always
 * shown.
 */
export type HelpFallbackCopy = {
  unavailable: string;
  foundUnverified: string;
  foundFailed: string;
  clarifyPage: string;
  clarifyGoal: string;
  securityNote: string;
};

const FALLBACK_COPY: Record<HelpLanguageCode, HelpFallbackCopy> = {
  en: {
    unavailable:
      "I couldn’t find a published StoreMink guide that confirms the answer. Try describing the screen you are on and what you want to complete, or contact support@storemink.com for help.",
    foundUnverified:
      "I found possible StoreMink guides, but I couldn’t verify an answer from them. Open the guides below, describe the screen you are on, or contact support@storemink.com.",
    foundFailed:
      "I found relevant StoreMink guides, but I couldn’t prepare a reliable step-by-step answer right now. Open the guides below for the verified instructions, or try again in a moment.",
    clarifyPage: "The StoreMink page or menu you are using",
    clarifyGoal:
      "What you want to complete and what happened after your last step",
    securityNote:
      "For your security, do not share passwords, one-time codes, card details, or private customer data in chat.",
  },
  hi: {
    unavailable:
      "ऐसी कोई प्रकाशित StoreMink गाइड नहीं मिली जो इस जवाब की पुष्टि करे। आप जिस स्क्रीन पर हैं और जो करना चाहते हैं, उसके बारे में बताएँ, या मदद के लिए support@storemink.com पर लिखें।",
    foundUnverified:
      "कुछ StoreMink गाइड मिलीं, लेकिन उनसे जवाब की पुष्टि नहीं हो पाई। नीचे दी गई गाइड खोलें, अपनी स्क्रीन के बारे में बताएँ, या support@storemink.com पर लिखें।",
    foundFailed:
      "काम की StoreMink गाइड मिल गईं, लेकिन अभी भरोसेमंद कदम-दर-कदम जवाब तैयार नहीं हो पाया। सही निर्देशों के लिए नीचे दी गई गाइड खोलें, या थोड़ी देर में फिर कोशिश करें।",
    clarifyPage: "आप StoreMink का कौन सा पेज या मेन्यू इस्तेमाल कर रहे हैं",
    clarifyGoal: "आप क्या पूरा करना चाहते हैं और पिछले कदम के बाद क्या हुआ",
    securityNote:
      "अपनी सुरक्षा के लिए चैट में पासवर्ड, OTP, कार्ड की जानकारी या ग्राहकों की निजी जानकारी न डालें।",
  },
  bn: {
    unavailable:
      "এমন কোনো প্রকাশিত StoreMink গাইড পাওয়া যায়নি যা এই উত্তর নিশ্চিত করে। আপনি কোন স্ক্রিনে আছেন এবং কী করতে চান তা জানান, অথবা সাহায্যের জন্য support@storemink.com-এ লিখুন।",
    foundUnverified:
      "কিছু StoreMink গাইড পাওয়া গেছে, কিন্তু সেগুলো থেকে উত্তর নিশ্চিত করা যায়নি। নিচের গাইডগুলো খুলুন, আপনার স্ক্রিনের কথা জানান, অথবা support@storemink.com-এ লিখুন।",
    foundFailed:
      "প্রাসঙ্গিক StoreMink গাইড পাওয়া গেছে, কিন্তু এখনই নির্ভরযোগ্য ধাপে ধাপে উত্তর তৈরি করা যায়নি। সঠিক নির্দেশের জন্য নিচের গাইডগুলো খুলুন, অথবা একটু পরে আবার চেষ্টা করুন।",
    clarifyPage: "আপনি StoreMink-এর কোন পেজ বা মেনু ব্যবহার করছেন",
    clarifyGoal: "আপনি কী করতে চান এবং শেষ ধাপের পরে কী হয়েছে",
    securityNote:
      "আপনার নিরাপত্তার জন্য চ্যাটে পাসওয়ার্ড, OTP, কার্ডের তথ্য বা গ্রাহকের ব্যক্তিগত তথ্য দেবেন না।",
  },
  ta: {
    unavailable:
      "இந்தப் பதிலை உறுதிப்படுத்தும் வெளியிடப்பட்ட StoreMink வழிகாட்டி எதுவும் கிடைக்கவில்லை. நீங்கள் இருக்கும் திரையையும் நீங்கள் செய்ய விரும்புவதையும் விவரியுங்கள், அல்லது உதவிக்கு support@storemink.com-க்கு எழுதுங்கள்.",
    foundUnverified:
      "சில StoreMink வழிகாட்டிகள் கிடைத்தன, ஆனால் அவற்றிலிருந்து பதிலை உறுதிப்படுத்த முடியவில்லை. கீழே உள்ள வழிகாட்டிகளைத் திறங்கள், உங்கள் திரையை விவரியுங்கள், அல்லது support@storemink.com-க்கு எழுதுங்கள்.",
    foundFailed:
      "தொடர்புடைய StoreMink வழிகாட்டிகள் கிடைத்தன, ஆனால் இப்போது நம்பகமான படிப்படியான பதிலைத் தயாரிக்க முடியவில்லை. சரியான வழிமுறைகளுக்குக் கீழே உள்ள வழிகாட்டிகளைத் திறங்கள், அல்லது சிறிது நேரம் கழித்து மீண்டும் முயலுங்கள்.",
    clarifyPage: "நீங்கள் பயன்படுத்தும் StoreMink பக்கம் அல்லது மெனு",
    clarifyGoal:
      "நீங்கள் என்ன செய்ய விரும்புகிறீர்கள், கடைசிப் படிக்குப் பிறகு என்ன நடந்தது",
    securityNote:
      "உங்கள் பாதுகாப்புக்காக, உரையாடலில் கடவுச்சொல், OTP, கார்டு விவரங்கள் அல்லது வாடிக்கையாளர்களின் தனிப்பட்ட தகவல்களைப் பகிர வேண்டாம்.",
  },
  te: {
    unavailable:
      "ఈ సమాధానాన్ని నిర్ధారించే ప్రచురించిన StoreMink గైడ్ ఏదీ దొరకలేదు. మీరు ఉన్న స్క్రీన్ మరియు మీరు చేయాలనుకుంటున్నది వివరించండి, లేదా సహాయం కోసం support@storemink.com కు రాయండి.",
    foundUnverified:
      "కొన్ని StoreMink గైడ్‌లు దొరికాయి, కానీ వాటి నుండి సమాధానాన్ని నిర్ధారించలేకపోయాం. కింద ఉన్న గైడ్‌లను తెరవండి, మీ స్క్రీన్ గురించి చెప్పండి, లేదా support@storemink.com కు రాయండి.",
    foundFailed:
      "సంబంధిత StoreMink గైడ్‌లు దొరికాయి, కానీ ఇప్పుడు నమ్మదగిన దశలవారీ సమాధానాన్ని సిద్ధం చేయలేకపోయాం. సరైన సూచనల కోసం కింద ఉన్న గైడ్‌లను తెరవండి, లేదా కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.",
    clarifyPage: "మీరు ఉపయోగిస్తున్న StoreMink పేజీ లేదా మెనూ",
    clarifyGoal:
      "మీరు ఏమి పూర్తి చేయాలనుకుంటున్నారు, చివరి దశ తర్వాత ఏమి జరిగింది",
    securityNote:
      "మీ భద్రత కోసం, చాట్‌లో పాస్‌వర్డ్‌లు, OTP లు, కార్డ్ వివరాలు లేదా కస్టమర్ల వ్యక్తిగత సమాచారాన్ని పంచుకోవద్దు.",
  },
  mr: {
    unavailable:
      "या उत्तराची खात्री करणारा प्रकाशित StoreMink मार्गदर्शक सापडला नाही. तुम्ही कोणत्या स्क्रीनवर आहात आणि काय पूर्ण करायचे आहे ते सांगा, किंवा मदतीसाठी support@storemink.com वर लिहा.",
    foundUnverified:
      "काही StoreMink मार्गदर्शक सापडले, पण त्यांतून उत्तराची खात्री करता आली नाही. खालील मार्गदर्शक उघडा, तुमच्या स्क्रीनबद्दल सांगा, किंवा support@storemink.com वर लिहा.",
    foundFailed:
      "संबंधित StoreMink मार्गदर्शक सापडले, पण आत्ता विश्वासार्ह टप्प्याटप्प्याचे उत्तर तयार करता आले नाही. योग्य सूचनांसाठी खालील मार्गदर्शक उघडा, किंवा थोड्या वेळाने पुन्हा प्रयत्न करा.",
    clarifyPage: "तुम्ही वापरत असलेले StoreMink पेज किंवा मेनू",
    clarifyGoal:
      "तुम्हाला काय पूर्ण करायचे आहे आणि शेवटच्या टप्प्यानंतर काय झाले",
    securityNote:
      "तुमच्या सुरक्षेसाठी चॅटमध्ये पासवर्ड, OTP, कार्डची माहिती किंवा ग्राहकांची खासगी माहिती देऊ नका.",
  },
  gu: {
    unavailable:
      "આ જવાબની ખાતરી કરતી કોઈ પ્રકાશિત StoreMink માર્ગદર્શિકા મળી નથી. તમે કઈ સ્ક્રીન પર છો અને શું પૂરું કરવા માંગો છો તે જણાવો, અથવા મદદ માટે support@storemink.com પર લખો.",
    foundUnverified:
      "કેટલીક StoreMink માર્ગદર્શિકાઓ મળી, પણ તેમાંથી જવાબની ખાતરી થઈ શકી નથી. નીચેની માર્ગદર્શિકાઓ ખોલો, તમારી સ્ક્રીન વિશે જણાવો, અથવા support@storemink.com પર લખો.",
    foundFailed:
      "સંબંધિત StoreMink માર્ગદર્શિકાઓ મળી, પણ અત્યારે ભરોસાપાત્ર પગલું-દર-પગલું જવાબ તૈયાર થઈ શક્યો નથી. સાચી સૂચનાઓ માટે નીચેની માર્ગદર્શિકાઓ ખોલો, અથવા થોડી વાર પછી ફરી પ્રયાસ કરો.",
    clarifyPage: "તમે વાપરી રહ્યા છો તે StoreMink પેજ અથવા મેનૂ",
    clarifyGoal: "તમે શું પૂરું કરવા માંગો છો અને છેલ્લા પગલા પછી શું થયું",
    securityNote:
      "તમારી સુરક્ષા માટે ચેટમાં પાસવર્ડ, OTP, કાર્ડની વિગતો અથવા ગ્રાહકોની ખાનગી માહિતી ન આપો.",
  },
  kn: {
    unavailable:
      "ಈ ಉತ್ತರವನ್ನು ಖಚಿತಪಡಿಸುವ ಪ್ರಕಟಿತ StoreMink ಮಾರ್ಗದರ್ಶಿ ಸಿಗಲಿಲ್ಲ. ನೀವು ಯಾವ ಪರದೆಯಲ್ಲಿದ್ದೀರಿ ಮತ್ತು ಏನು ಪೂರ್ಣಗೊಳಿಸಲು ಬಯಸುತ್ತೀರಿ ಎಂದು ತಿಳಿಸಿ, ಅಥವಾ ಸಹಾಯಕ್ಕಾಗಿ support@storemink.com ಗೆ ಬರೆಯಿರಿ.",
    foundUnverified:
      "ಕೆಲವು StoreMink ಮಾರ್ಗದರ್ಶಿಗಳು ಸಿಕ್ಕಿವೆ, ಆದರೆ ಅವುಗಳಿಂದ ಉತ್ತರವನ್ನು ಖಚಿತಪಡಿಸಲು ಆಗಲಿಲ್ಲ. ಕೆಳಗಿನ ಮಾರ್ಗದರ್ಶಿಗಳನ್ನು ತೆರೆಯಿರಿ, ನಿಮ್ಮ ಪರದೆಯ ಬಗ್ಗೆ ತಿಳಿಸಿ, ಅಥವಾ support@storemink.com ಗೆ ಬರೆಯಿರಿ.",
    foundFailed:
      "ಸಂಬಂಧಿತ StoreMink ಮಾರ್ಗದರ್ಶಿಗಳು ಸಿಕ್ಕಿವೆ, ಆದರೆ ಈಗ ವಿಶ್ವಾಸಾರ್ಹ ಹಂತ ಹಂತದ ಉತ್ತರವನ್ನು ಸಿದ್ಧಪಡಿಸಲು ಆಗಲಿಲ್ಲ. ಸರಿಯಾದ ಸೂಚನೆಗಳಿಗಾಗಿ ಕೆಳಗಿನ ಮಾರ್ಗದರ್ಶಿಗಳನ್ನು ತೆರೆಯಿರಿ, ಅಥವಾ ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
    clarifyPage: "ನೀವು ಬಳಸುತ್ತಿರುವ StoreMink ಪುಟ ಅಥವಾ ಮೆನು",
    clarifyGoal:
      "ನೀವು ಏನು ಪೂರ್ಣಗೊಳಿಸಲು ಬಯಸುತ್ತೀರಿ ಮತ್ತು ಕೊನೆಯ ಹಂತದ ನಂತರ ಏನಾಯಿತು",
    securityNote:
      "ನಿಮ್ಮ ಸುರಕ್ಷತೆಗಾಗಿ ಚಾಟ್‌ನಲ್ಲಿ ಪಾಸ್‌ವರ್ಡ್, OTP, ಕಾರ್ಡ್ ವಿವರಗಳು ಅಥವಾ ಗ್ರಾಹಕರ ಖಾಸಗಿ ಮಾಹಿತಿಯನ್ನು ಹಂಚಿಕೊಳ್ಳಬೇಡಿ.",
  },
  pa: {
    unavailable:
      "ਇਸ ਜਵਾਬ ਦੀ ਪੁਸ਼ਟੀ ਕਰਨ ਵਾਲੀ ਕੋਈ ਪ੍ਰਕਾਸ਼ਿਤ StoreMink ਗਾਈਡ ਨਹੀਂ ਮਿਲੀ। ਤੁਸੀਂ ਕਿਸ ਸਕ੍ਰੀਨ 'ਤੇ ਹੋ ਅਤੇ ਕੀ ਪੂਰਾ ਕਰਨਾ ਚਾਹੁੰਦੇ ਹੋ, ਦੱਸੋ, ਜਾਂ ਮਦਦ ਲਈ support@storemink.com 'ਤੇ ਲਿਖੋ।",
    foundUnverified:
      "ਕੁਝ StoreMink ਗਾਈਡਾਂ ਮਿਲੀਆਂ, ਪਰ ਉਨ੍ਹਾਂ ਤੋਂ ਜਵਾਬ ਦੀ ਪੁਸ਼ਟੀ ਨਹੀਂ ਹੋ ਸਕੀ। ਹੇਠਾਂ ਦਿੱਤੀਆਂ ਗਾਈਡਾਂ ਖੋਲ੍ਹੋ, ਆਪਣੀ ਸਕ੍ਰੀਨ ਬਾਰੇ ਦੱਸੋ, ਜਾਂ support@storemink.com 'ਤੇ ਲਿਖੋ।",
    foundFailed:
      "ਸੰਬੰਧਿਤ StoreMink ਗਾਈਡਾਂ ਮਿਲ ਗਈਆਂ, ਪਰ ਹੁਣੇ ਭਰੋਸੇਯੋਗ ਕਦਮ-ਦਰ-ਕਦਮ ਜਵਾਬ ਤਿਆਰ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਸਹੀ ਹਦਾਇਤਾਂ ਲਈ ਹੇਠਾਂ ਦਿੱਤੀਆਂ ਗਾਈਡਾਂ ਖੋਲ੍ਹੋ, ਜਾਂ ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    clarifyPage: "ਤੁਸੀਂ ਜਿਹੜਾ StoreMink ਪੰਨਾ ਜਾਂ ਮੀਨੂ ਵਰਤ ਰਹੇ ਹੋ",
    clarifyGoal: "ਤੁਸੀਂ ਕੀ ਪੂਰਾ ਕਰਨਾ ਚਾਹੁੰਦੇ ਹੋ ਅਤੇ ਪਿਛਲੇ ਕਦਮ ਤੋਂ ਬਾਅਦ ਕੀ ਹੋਇਆ",
    securityNote:
      "ਆਪਣੀ ਸੁਰੱਖਿਆ ਲਈ ਚੈਟ ਵਿੱਚ ਪਾਸਵਰਡ, OTP, ਕਾਰਡ ਦੀ ਜਾਣਕਾਰੀ ਜਾਂ ਗਾਹਕਾਂ ਦੀ ਨਿੱਜੀ ਜਾਣਕਾਰੀ ਨਾ ਦਿਓ।",
  },
};

export function helpFallbackCopy(code: unknown): HelpFallbackCopy {
  return FALLBACK_COPY[helpLanguage(code).code];
}
