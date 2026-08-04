import { readFileSync } from "fs";

/**
 * Registry of the consent management platforms (CMPs) we know how to detect and
 * remove. The migration is not Cookiebot-specific: it should lift a site off
 * whatever consent tool it currently uses (or none) and onto Consentify.
 *
 * For each CMP:
 *  - `presence`   — patterns that indicate the CMP is on the page (detection).
 *  - `srcDomains` — regex fragments matching <script src> hosts to strip.
 *  - `inline`     — signatures inside inline <script> blocks to strip.
 *  - `dataAttrs`  — standalone data-* attribute names to strip.
 */
export interface CmpDefinition {
  id: string;
  name: string;
  presence: RegExp[];
  srcDomains: string[];
  inline: string[];
  dataAttrs: string[];
}

export const CMP_DEFINITIONS: CmpDefinition[] = [
  {
    id: "cookiebot",
    name: "Cookiebot",
    presence: [/consent\.cookiebot\.com/i, /data-cbid/i, /\bCookiebot\b/, /window\.Cookiebot\b/],
    srcDomains: ["consent\\.cookiebot\\.com"],
    inline: ["window\\.Cookiebot\\b"],
    dataAttrs: ["data-cbid"],
  },
  {
    id: "onetrust",
    name: "OneTrust",
    presence: [/cdn\.cookielaw\.org/i, /otSDKStub\.js/i, /data-domain-script/i, /window\.OneTrust\b/, /OptanonWrapper/],
    srcDomains: ["cdn\\.cookielaw\\.org", "optanon\\.blob\\.core\\.windows\\.net", "geolocation\\.onetrust\\.com"],
    inline: ["OptanonWrapper", "window\\.OneTrust\\b", "window\\.Optanon\\b"],
    dataAttrs: ["data-domain-script"],
  },
  {
    id: "cookieyes",
    name: "CookieYes",
    presence: [/cdn-cookieyes\.com/i, /app\.cookieyes\.com/i, /\bcookieyes\b/i],
    srcDomains: ["cdn-cookieyes\\.com", "app\\.cookieyes\\.com"],
    inline: [],
    dataAttrs: [],
  },
  {
    id: "cookiefirst",
    name: "CookieFirst",
    presence: [/consent\.cookiefirst\.com/i, /cookiefirst/i, /window\.CookieFirst\b/],
    srcDomains: ["consent\\.cookiefirst\\.com"],
    inline: ["window\\.CookieFirst\\b"],
    dataAttrs: ["data-cookiefirst-key"],
  },
  {
    id: "termly",
    name: "Termly",
    presence: [/app\.termly\.io/i, /\btermly\b/i],
    srcDomains: ["app\\.termly\\.io"],
    inline: [],
    dataAttrs: ["data-website-uuid"],
  },
  {
    id: "osano",
    name: "Osano",
    presence: [/cmp\.osano\.com/i, /window\.Osano\b/],
    srcDomains: ["cmp\\.osano\\.com"],
    inline: ["window\\.Osano\\b"],
    dataAttrs: [],
  },
  {
    id: "iubenda",
    name: "Iubenda",
    presence: [/cdn\.iubenda\.com/i, /cs\.iubenda\.com/i, /\biubenda\b/i, /_iub\b/],
    srcDomains: ["cdn\\.iubenda\\.com", "cs\\.iubenda\\.com"],
    inline: ["_iub\\b", "window\\._iub\\b"],
    dataAttrs: [],
  },
  {
    id: "usercentrics",
    name: "Usercentrics",
    presence: [/usercentrics\.eu/i, /\busercentrics\b/i, /window\.UC_UI\b/, /data-settings-id/i],
    srcDomains: ["app\\.usercentrics\\.eu", "api\\.usercentrics\\.eu", "web\\.cmp\\.usercentrics\\.eu"],
    inline: ["window\\.UC_UI\\b"],
    dataAttrs: ["data-settings-id", "data-usercentrics"],
  },
  {
    id: "didomi",
    name: "Didomi",
    presence: [/sdk\.privacy-center\.org/i, /\bdidomi\b/i, /window\.Didomi\b/, /gdprAppliesGlobally/],
    srcDomains: ["sdk\\.privacy-center\\.org"],
    inline: ["window\\.didomiConfig", "window\\.Didomi\\b", "gdprAppliesGlobally"],
    dataAttrs: [],
  },
  {
    id: "trustarc",
    name: "TrustArc",
    presence: [/consent\.trustarc\.com/i, /choices\.truste\.com/i, /\btrustarc\b/i],
    srcDomains: ["consent\\.trustarc\\.com", "choices\\.truste\\.com", "consent\\.truste\\.com"],
    inline: [],
    dataAttrs: [],
  },
  {
    id: "civic",
    name: "Civic Cookie Control",
    presence: [/cc\.cdn\.civiccomputing\.com/i, /CookieControl\b/],
    srcDomains: ["cc\\.cdn\\.civiccomputing\\.com"],
    inline: ["CookieControl\\.load"],
    dataAttrs: [],
  },
  {
    id: "cookiescript",
    name: "Cookie Script",
    presence: [/cookie-script\.com/i, /cookiescript/i],
    srcDomains: ["cdn\\.cookie-script\\.com"],
    inline: [],
    dataAttrs: [],
  },
  {
    id: "klaro",
    name: "Klaro",
    presence: [/kiprotect\.com\/klaro/i, /klaroConfig/, /data-klaro/i],
    srcDomains: ["kiprotect\\.com/klaro"],
    inline: ["window\\.klaroConfig", "klaroConfig"],
    dataAttrs: [],
  },
  {
    id: "complianz",
    name: "Complianz",
    presence: [/complianz/i, /\bcmplz[_-]/i],
    srcDomains: [],
    inline: ["cmplz_"],
    dataAttrs: [],
  },
  {
    id: "borlabs",
    name: "Borlabs Cookie",
    presence: [/borlabs-cookie/i, /BorlabsCookie/],
    srcDomains: [],
    inline: ["window\\.BorlabsCookie", "BorlabsCookie"],
    dataAttrs: [],
  },
  {
    id: "quantcast",
    name: "Quantcast Choice",
    presence: [/quantcast\.mgr\.consensu\.org/i, /\bquantcast\b/i],
    srcDomains: ["quantcast\\.mgr\\.consensu\\.org"],
    inline: [],
    dataAttrs: [],
  },
  {
    id: "sourcepoint",
    name: "Sourcepoint",
    presence: [/cmp\.sp-prod\.net/i, /\bsourcepoint\b/i, /window\._sp_\b/],
    srcDomains: ["cmp\\.sp-prod\\.net"],
    inline: ["window\\._sp_\\b"],
    dataAttrs: [],
  },
  {
    id: "cookieconsent",
    name: "Cookie Consent (Orest Bida)",
    presence: [/vanilla-cookieconsent/i, /cookieconsent@/i, /initCookieConsent/, /CookieConsent\.run/],
    srcDomains: [
      "cdn\\.jsdelivr\\.net/gh/orestbida/cookieconsent",
      "cdn\\.jsdelivr\\.net/npm/vanilla-cookieconsent",
      "cdnjs\\.cloudflare\\.com/ajax/libs/cookieconsent",
    ],
    inline: ["initCookieConsent", "window\\.CookieConsent", "CookieConsent\\.run"],
    dataAttrs: [],
  },
];

export interface CmpMatch {
  file: string;
  /** Human names of the CMP(s) detected in this file. */
  cmps: string[];
  /** 1-based line numbers where a CMP signal was found. */
  lines: number[];
}

/**
 * Scan one file for any known CMP. Returns null when the file is clean.
 */
export function scanFileForCmp(filePath: string): CmpMatch | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const cmps = new Set<string>();
  const matchedLines = new Set<number>();

  for (const def of CMP_DEFINITIONS) {
    let hit = false;
    for (const re of def.presence) {
      if (re.test(content)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;

    cmps.add(def.name);
    lines.forEach((line, idx) => {
      if (def.presence.some((re) => re.test(line))) matchedLines.add(idx + 1);
    });
  }

  if (cmps.size === 0) return null;

  return {
    file: filePath,
    cmps: [...cmps],
    lines: [...matchedLines].sort((a, b) => a - b),
  };
}

/** Combined removal patterns across all CMPs, for the transform step. */
export function getCmpRemovalPatterns(): {
  srcDomains: string[];
  inline: string[];
  dataAttrs: string[];
} {
  const srcDomains: string[] = [];
  const inline: string[] = [];
  const dataAttrs: string[] = [];
  for (const def of CMP_DEFINITIONS) {
    srcDomains.push(...def.srcDomains);
    inline.push(...def.inline);
    dataAttrs.push(...def.dataAttrs);
  }
  return { srcDomains, inline, dataAttrs };
}
