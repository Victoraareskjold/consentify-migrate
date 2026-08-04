import { readFileSync } from "fs";
import { relative, sep } from "path";

/**
 * Common privacy / cookie policy URL slugs across languages. Ordered by
 * preference: a dedicated privacy page beats a generic cookie page.
 */
const POLICY_SLUGS = [
  "privacy-policy",
  "personvernerklaering",
  "personvernerklæring",
  "personvern",
  "privacy",
  "privatlivspolitik", // dk
  "integritetspolicy", // se
  "datenschutz", // de
  "politique-de-confidentialite", // fr
  "privacybeleid", // nl
  "privacidad", // es
  "cookie-policy",
  "cookie-erklaering",
  "cookies",
  "gdpr",
];

// Match a slug appearing as a route segment in a file path (e.g.
// app/personvern/page.tsx, pages/privacy-policy.tsx, src/routes/cookies/+page.svelte)
const PATH_SEGMENT = new RegExp(
  `(?:^|[/\\\\])(${POLICY_SLUGS.join("|")})(?:[/\\\\.]|$)`,
  "i",
);

// Match a link to the policy in source content: href="/personvern" etc.
const HREF_LINK = new RegExp(
  `(?:href|to)=["'\`]/?(${POLICY_SLUGS.join("|")})(?:/["'\`]|["'\`])`,
  "i",
);

/**
 * Try to find the site's privacy/cookie policy path by inspecting the project.
 * Returns a URL path segment (e.g. "personvern") without a leading slash, or
 * null if nothing convincing was found.
 *
 * Strategy:
 *  1. Look at file/route names (a page dedicated to the policy).
 *  2. Fall back to scanning source for a link to a policy route.
 */
export function detectPrivacyPath(
  projectDir: string,
  files: string[],
): string | null {
  // 1. Route/file names — strongest signal.
  for (const abs of files) {
    const rel = relative(projectDir, abs).split(sep).join("/");
    const m = rel.match(PATH_SEGMENT);
    if (m) return normalizeSlug(m[1]);
  }

  // 2. Links inside source files.
  for (const abs of files) {
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const m = content.match(HREF_LINK);
    if (m) return normalizeSlug(m[1]);
  }

  return null;
}

function normalizeSlug(slug: string): string {
  return slug.toLowerCase();
}

/**
 * Resolve the policy URL for a domain given (in priority order):
 *  - an explicit URL (e.g. from a manifest)
 *  - a slug detected in the project files → https://{domain}/{slug}
 *  - a pattern with {domain} placeholder
 * Returns undefined if none apply.
 */
export function resolvePolicyUrl(opts: {
  domain: string;
  explicit?: string;
  detectedSlug?: string | null;
  pattern?: string;
}): string | undefined {
  if (opts.explicit) return opts.explicit;
  if (opts.detectedSlug) return `https://${opts.domain}/${opts.detectedSlug}`;
  if (opts.pattern) return opts.pattern.replace("{domain}", opts.domain);
  return undefined;
}
