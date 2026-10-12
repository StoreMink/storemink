// Display names for Google Search Console dimension keys. Search Console
// returns devices as DESKTOP / MOBILE / TABLET and countries as lowercase
// ISO 3166-1 alpha-3 codes ("ind", "usa"). Intl.DisplayNames only knows the
// alpha-2 region codes, so the common markets are mapped here and anything
// else falls back to its upper-cased code rather than being guessed.

const DEVICE_NAMES: Record<string, string> = {
  DESKTOP: "Desktop",
  MOBILE: "Mobile",
  TABLET: "Tablet",
};

const ALPHA3_TO_ALPHA2: Record<string, string> = {
  ind: "IN",
  usa: "US",
  gbr: "GB",
  are: "AE",
  sau: "SA",
  qat: "QA",
  kwt: "KW",
  omn: "OM",
  bhr: "BH",
  sgp: "SG",
  mys: "MY",
  idn: "ID",
  tha: "TH",
  phl: "PH",
  vnm: "VN",
  chn: "CN",
  hkg: "HK",
  jpn: "JP",
  kor: "KR",
  aus: "AU",
  nzl: "NZ",
  can: "CA",
  mex: "MX",
  bra: "BR",
  deu: "DE",
  fra: "FR",
  ita: "IT",
  esp: "ES",
  nld: "NL",
  bel: "BE",
  che: "CH",
  swe: "SE",
  nor: "NO",
  dnk: "DK",
  irl: "IE",
  prt: "PT",
  pol: "PL",
  tur: "TR",
  rus: "RU",
  zaf: "ZA",
  nga: "NG",
  ken: "KE",
  egy: "EG",
  pak: "PK",
  bgd: "BD",
  lka: "LK",
  npl: "NP",
};

export function searchDeviceName(key: string): string {
  return DEVICE_NAMES[key.toUpperCase()] ?? key;
}

export function searchCountryName(key: string): string {
  const alpha2 = ALPHA3_TO_ALPHA2[key.toLowerCase()];
  if (!alpha2) return key.toUpperCase();
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "region" }).of(alpha2) ??
      key.toUpperCase()
    );
  } catch {
    return key.toUpperCase();
  }
}
