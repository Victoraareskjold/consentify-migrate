/**
 * Single source of truth for tracker detection AND removal.
 *
 * This file owns the regex patterns needed to (a) find a tracker in source or
 * extract its id, and (b) recognise a <script> block that belongs to it so the
 * block can be stripped. Trackers get re-injected by Consentify after consent,
 * which is the whole point of the migration.
 *
 * `SUPPORTED` below mirrors the live entries of the app's integration list
 * (lib/integrations/index.ts). We keep a local copy rather than importing that
 * file because it is a Next.js module (it reaches `@/utils/renderBanner` through
 * the type chain), and pulling it into this standalone CLI package breaks the
 * type-check and publish boundary. Anything NOT listed here (e.g. Matomo,
 * Mixpanel, Amplitude, Pinterest — currently commented out in the app) is
 * treated as "not a built-in integration": still stripped, but reported so the
 * user re-adds it as a custom integration.
 *
 * IMPORTANT: when an integration is added/removed or its `free` flag changes in
 * lib/integrations/index.ts, update this map to match.
 */
const SUPPORTED: Record<string, { name: string; free: boolean }> = {
  ga: { name: "Google Analytics", free: true },
  google_tag_manager: { name: "Google Tag Manager", free: true },
  fb_pixel: { name: "Facebook Pixel", free: true },
  google_ads: { name: "Google Ads", free: false },
  tiktok_pixel: { name: "TikTok Pixel", free: false },
  linkedin_insight: { name: "LinkedIn Insight Tag", free: false },
  snap_pixel: { name: "Snapchat Pixel", free: false },
  hubspot: { name: "HubSpot", free: false },
  contentsquare: { name: "Contentsquare", free: false },
  posthog: { name: "PostHog", free: false },
  intercom: { name: "Intercom", free: false },
};

export interface TrackerDef {
  /** Matches an app integration id when supported; otherwise a synthetic id. */
  id: string;
  /** Fallback display name, used only when the id isn't a live integration. */
  name: string;
  /**
   * Patterns that identify this tracker. A match against a whole <script> block
   * (or against a file, for detection) means the block belongs to this tracker.
   * Covers both the <script src> host and inline snippet signatures.
   */
  match: RegExp;
  /** Pulls the tracking id out of source, when we can set the tracker up. */
  idExtractor?: RegExp;
}

/**
 * Every tracker we know how to strip. Payment/consent-necessary and pure embed
 * integrations (Stripe, PayPal, Klarna, reCAPTCHA, YouTube, Calendly) are
 * deliberately absent: removing them would break checkout or embeds, and they
 * are not analytics/marketing trackers.
 */
export const TRACKERS: TrackerDef[] = [
  // ── Google ────────────────────────────────────────────────────────────────
  {
    id: "google_ads",
    name: "Google Ads",
    // Check Ads before GA: both use gtag/js, Ads is the AW- variant.
    match:
      /googletagmanager\.com\/gtag\/js\?id=AW-|gtag\(\s*['"]config['"]\s*,\s*['"]AW-/i,
    idExtractor: /\b(AW-\d{9,12})\b/,
  },
  {
    id: "ga",
    name: "Google Analytics",
    match:
      /googletagmanager\.com\/gtag\/js|gtag\(\s*['"]config['"]\s*,\s*['"]G-|function\s+gtag\s*\(/i,
    idExtractor: /gtag\(\s*['"]config['"]\s*,\s*['"]?(G-[A-Z0-9]{4,12})/,
  },
  {
    id: "google_tag_manager",
    name: "Google Tag Manager",
    match: /googletagmanager\.com\/gtm\.js|['"]gtm\.start['"]/i,
    idExtractor: /\b(GTM-[A-Z0-9]{4,9})\b/,
  },
  // ── Meta ──────────────────────────────────────────────────────────────────
  {
    id: "fb_pixel",
    name: "Facebook Pixel",
    match:
      /connect\.facebook\.net|fbq\(\s*['"]init['"]|n\.callMethod\.apply\(n,arguments\)/i,
    idExtractor: /fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{10,18})/,
  },
  // ── Paid ad / social pixels ───────────────────────────────────────────────
  {
    id: "tiktok_pixel",
    name: "TikTok Pixel",
    match: /analytics\.tiktok\.com|ttq\.load\s*\(|TiktokAnalyticsObject/i,
    idExtractor: /ttq\.load\(\s*['"]([A-Z0-9]{15,25})['"]/,
  },
  {
    id: "linkedin_insight",
    name: "LinkedIn Insight Tag",
    match: /snap\.licdn\.com|_linkedin_partner_id/i,
    idExtractor: /_linkedin_partner_id\s*=\s*['"]?(\d+)/,
  },
  {
    id: "snap_pixel",
    name: "Snapchat Pixel",
    // Real snippet uses e.snaptr / snaptr('init'); the old window.snaptr check missed it.
    match: /sc-static\.net\/scevent|snaptr\s*\(/i,
    idExtractor: /snaptr\(\s*['"]init['"]\s*,\s*['"]([A-Za-z0-9-]{8,40})['"]/,
  },
  {
    id: "pinterest_tag",
    name: "Pinterest Tag",
    match: /s\.pinimg\.com\/ct|pintrk\s*\(/i,
    idExtractor: /pintrk\(\s*['"]load['"]\s*,\s*['"]([0-9]{6,20})['"]/,
  },
  // ── Analytics / product / marketing ───────────────────────────────────────
  {
    id: "hubspot",
    name: "HubSpot",
    match: /(?:js|track)\.hs-scripts\.com|js\.hs-analytics\.net|_hsq\b/i,
    idExtractor: /hs-scripts\.com\/(\d{6,12})\.js/,
  },
  {
    id: "contentsquare",
    name: "Contentsquare",
    match: /t\.contentsquare\.net|_uxa\b/i,
    idExtractor: /uxa\/([a-f0-9]{10,20})\.js/,
  },
  {
    id: "posthog",
    name: "PostHog",
    match:
      /posthog\.init\s*\(|(?:^|[/.])(?:eu\.i|app|i)\.posthog\.com|posthog\.com\/static/i,
    idExtractor: /posthog\.init\(\s*['"]?(phc_[A-Za-z0-9_-]{16,})/,
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    match: /cdn\.mxpnl\.com|mixpanel\.init\s*\(|mixpanel\.__SV/i,
    idExtractor: /mixpanel\.init\(\s*['"]([A-Za-z0-9]{16,40})['"]/,
  },
  {
    id: "amplitude",
    name: "Amplitude",
    match: /cdn\.amplitude\.com|amplitude\.getInstance\s*\(/i,
    idExtractor: /getInstance\(\)\.init\(\s*['"]([A-Za-z0-9]{16,40})['"]/,
  },
  {
    id: "matomo",
    name: "Matomo",
    match: /\/matomo\.js|_paq\.push/i,
  },
  {
    id: "intercom",
    name: "Intercom",
    match:
      /widget\.intercom\.io|js\.intercomcdn\.com|intercomSettings|window\.Intercom\b/i,
    idExtractor: /app_id:\s*['"]([a-z0-9]{6,10})['"]/,
  },
  // ── Not built-in integrations (removed + reported, add as custom) ──────────
  {
    id: "twitter",
    name: "X / Twitter Pixel",
    match: /static\.ads-twitter\.com|\btwq\s*\(/i,
  },
  {
    id: "reddit",
    name: "Reddit Pixel",
    match: /redditstatic\.com\/ads\/pixel|\brdt\s*\(/i,
  },
  {
    id: "clarity",
    name: "Microsoft Clarity",
    match: /clarity\.ms\/tag|["']clarity["']\s*,\s*["']script["']/i,
  },
  {
    id: "hotjar",
    name: "Hotjar",
    match: /static\.hotjar\.com|_hjSettings|hjid\s*:/i,
  },
  {
    id: "segment",
    name: "Segment",
    match:
      /cdn\.segment\.com\/analytics\.js|analytics\.load\s*\(|analytics\.invoked/i,
  },
];

export type TrackerSupport = "free" | "paid" | "unsupported";

/** How a detected tracker relates to the user's Consentify plan. */
export function classifyTracker(id: string): {
  name: string;
  support: TrackerSupport;
} {
  const supported = SUPPORTED[id];
  if (!supported) {
    const def = TRACKERS.find((t) => t.id === id);
    return { name: def?.name ?? id, support: "unsupported" };
  }
  return { name: supported.name, support: supported.free ? "free" : "paid" };
}

/** Display name for a tracker id (integration name wins). */
export function trackerName(id: string): string {
  return classifyTracker(id).name;
}

/** Ids of every tracker whose pattern appears anywhere in `text`. */
export function detectTrackerIds(text: string): string[] {
  const ids: string[] = [];
  for (const t of TRACKERS) {
    if (t.match.test(text)) ids.push(t.id);
  }
  return ids;
}

/** True if a single <script> block belongs to any known tracker. */
export function blockIsTracker(block: string): boolean {
  return TRACKERS.some((t) => t.match.test(block));
}

/**
 * True for values that are obviously not a real tracking id: snippet-template
 * placeholders (`G-XXXXXXXXXX`, `GTM-XXXXXXX`, `XXXXXXXX`), template tokens
 * (`YOUR_PIXEL_ID`, `SEGMENT_WRITE_KEY`), and env-var references. We must not
 * configure these — otherwise a copy-pasted template would set up integrations
 * with junk ids (the reason GA/GTM/Snap slipped through before).
 */
export function isPlaceholderId(id: string): boolean {
  return (
    /x{4,}/i.test(id) || // runs of X used in snippet templates
    /\byour[_-]?/i.test(id) || // YOUR_ID, your-pixel
    /(write_key|api_key|pixel_?id|partner_?id|project_?id|tag_?id|site_?id|token)/i.test(
      id,
    ) ||
    /process\.env|import\.meta\.env|\$\{/.test(id) || // env-var references
    id.replace(/[^A-Za-z0-9]/g, "").length < 4 // too short to be meaningful
  );
}

/**
 * Extract tracking ids for supported integrations found in `text`.
 * Only integrations that are live in the app (and have an extractor) are
 * returned, so we never try to configure something the product can't render.
 * Placeholder / template values are rejected so they route to manual setup
 * instead of being saved as a real id.
 */
export function extractSupportedIds(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of TRACKERS) {
    if (!(t.id in SUPPORTED) || !t.idExtractor) continue;
    if (!t.match.test(text)) continue;
    const m = text.match(t.idExtractor);
    if (m?.[1] && !isPlaceholderId(m[1])) out[t.id] = m[1];
  }
  return out;
}
