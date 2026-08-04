import { glob } from "glob";
import { relative } from "path";

import { detectFramework, type Framework } from "./detect/framework.js";
import { scanFileForCmp } from "./detect/cmp.js";
import {
  scanFileForIntegrations,
  mergeIntegrations,
} from "./detect/integrations.js";
import { detectPrivacyPath, resolvePolicyUrl } from "./detect/policy.js";
import { stripTrackingFromFile, injectConsentify } from "./transform/index.js";
import { classifyTracker } from "./detect/trackers.js";
import { commitAndPush, type GitMode, type GitResult } from "./git/index.js";
import { setupDomain, scanDomain, type DetectedTracker } from "./api.js";

export interface ProcessContext {
  accessToken: string;
  teamId: string;
  domain: string;
  /** Explicit policy URL (e.g. from a manifest). Highest priority. */
  policyUrlExplicit?: string;
  /** Pattern with {domain} placeholder, used if nothing is detected. */
  policyPattern?: string;
  /** Use the live GDPR scanner for integration detection (onboarding parity). */
  useScanner: boolean;
  gitMode: GitMode;
  /** When true, detect + report only. No API calls, no file writes, no git. */
  dryRun: boolean;
}

export interface ProjectResult {
  dir: string;
  domain: string;
  framework: Framework;
  frameworkLabel: string;
  placement: string;
  status: "success" | "skipped" | "error";
  publicToken?: string;
  policyUrl?: string;
  /** How integrations were detected. */
  detectionSource: "scanner" | "code" | "none";
  integrations: Record<string, string>;
  integrationsNeedingManual: string[];
  /**
   * Trackers removed from the code that aren't built-in Consentify integrations.
   * They stop firing (good for GDPR) but need re-adding as custom integrations.
   */
  unsupportedTrackers: string[];
  /**
   * Supported integrations that were detected but NOT enabled because the team's
   * plan doesn't include them. Names, for an "upgrade to enable" hint.
   */
  planBlockedIntegrations: string[];
  /** Names of consent tools (CMPs) found, e.g. ["Cookiebot"] or [] if none. */
  detectedCmps: string[];
  /** Files where an existing CMP was found (and removed). */
  cmpFiles: string[];
  changedFiles: string[];
  /** True when the Consentify tag was actually written into an entry file. */
  injected?: boolean;
  git?: GitResult;
  scanError?: string;
  error?: string;
}

const IGNORE = [
  "**/node_modules/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/vendor/**",
];

/** Map a scanner tracker category onto a consent category (mirrors server). */
function toConsentCategory(category: string): string {
  switch (category) {
    case "analytics":
      return "analytics";
    case "advertising":
    case "marketing":
    case "social":
    case "fingerprinting":
      return "marketing";
    case "cdn":
    case "cmp":
      return "necessary";
    default:
      return "functional";
  }
}

/**
 * Run the full migration on a single project directory.
 * Never throws for expected failures — returns a ProjectResult with
 * status "error" so a bulk run can continue to the next project.
 */
export async function processProject(
  projectDir: string,
  ctx: ProcessContext,
): Promise<ProjectResult> {
  const framework = detectFramework(projectDir);

  const base: ProjectResult = {
    dir: projectDir,
    domain: ctx.domain,
    framework: framework.type,
    frameworkLabel: framework.label,
    placement: framework.placement,
    status: "success",
    detectionSource: "none",
    integrations: {},
    integrationsNeedingManual: [],
    unsupportedTrackers: [],
    planBlockedIntegrations: [],
    detectedCmps: [],
    cmpFiles: [],
    changedFiles: [],
  };

  // ── Refuse to touch anything we can't finish ──────────────────────────────
  // Stripping trackers without injecting the Consentify tag leaves a site with
  // no analytics AND no consent gate, which is strictly worse than not running.
  // The "unknown" framework globs **/* and has no entry file, so without this
  // guard a run from the wrong directory quietly rewrites every project below it.
  if (framework.type === "unknown" && framework.entryFiles.length === 0) {
    return {
      ...base,
      status: "error",
      error:
        "No framework or entry point detected here. Run this from a project root, " +
        "or use `bulk` to set up a folder of projects.",
    };
  }

  // ── Scan project files (Cookiebot + policy path + code-level integrations) ──
  let files: string[];
  try {
    files = await glob(framework.searchGlobs, {
      cwd: projectDir,
      absolute: true,
      ignore: IGNORE,
      nodir: true,
    });
  } catch (err) {
    return { ...base, status: "error", error: `Scan failed: ${String(err)}` };
  }

  const cmpMatches = files
    .map((f) => scanFileForCmp(f))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  base.cmpFiles = cmpMatches.map((m) => relative(projectDir, m.file));
  base.detectedCmps = [...new Set(cmpMatches.flatMap((m) => m.cmps))];

  // Resolve the privacy policy URL: explicit > detected-in-code > pattern.
  const detectedSlug = detectPrivacyPath(projectDir, files);
  base.policyUrl = resolvePolicyUrl({
    domain: ctx.domain,
    explicit: ctx.policyUrlExplicit,
    detectedSlug,
    pattern: ctx.policyPattern,
  });

  // ── Integration detection ─────────────────────────────────────────────────
  let detectedTrackers: DetectedTracker[] = [];

  // Prefer the live scanner (same as dashboard onboarding). Fall back to
  // scanning the source code if the site isn't reachable or the scan fails.
  if (ctx.useScanner && !ctx.dryRun) {
    try {
      const scan = await scanDomain(ctx.accessToken, ctx.domain);
      const fromScan: Record<string, string> = {};
      for (const [id, det] of Object.entries(scan.detections ?? {})) {
        if (det.extractedId) fromScan[id] = det.extractedId;
      }
      if (Object.keys(fromScan).length > 0 || (scan.trackers ?? []).length > 0) {
        base.integrations = fromScan;
        base.detectionSource = "scanner";
        detectedTrackers = (scan.trackers ?? [])
          .filter(
            (t) =>
              !t.isCMP &&
              t.id !== "google_tag_manager" &&
              (t.isActive || t.networkCalls),
          )
          .map((t) => ({
            id: t.id,
            name: t.name,
            category: toConsentCategory(t.category),
          }));
      }
    } catch (err) {
      base.scanError = err instanceof Error ? err.message : String(err);
    }
  }

  // Code-based fallback (or primary when the scanner is disabled / dry run).
  if (base.detectionSource === "none") {
    const detected = mergeIntegrations(
      files.map((f) => scanFileForIntegrations(f)),
    );
    const withId = detected.filter((i) => i.trackingId);
    if (withId.length > 0) {
      base.integrations = Object.fromEntries(
        withId.map((i) => [i.id, i.trackingId as string]),
      );
      base.detectionSource = "code";
    }
    base.integrationsNeedingManual = detected
      .filter((i) => !i.trackingId)
      .map((i) => i.name);
  }

  // ── Dry run stops here ────────────────────────────────────────────────────
  if (ctx.dryRun) {
    base.status = "skipped";
    return base;
  }

  // Snapshot everything we detected before the server filters it by plan.
  const detectedIntegrationIds = Object.keys(base.integrations);

  // ── Create the domain on Consentify ───────────────────────────────────────
  try {
    const result = await setupDomain(ctx.accessToken, {
      teamId: ctx.teamId,
      domain: ctx.domain,
      policyUrl: base.policyUrl,
      integrations: base.integrations,
      detectedTrackers,
    });
    base.publicToken = result.publicToken;
    // Reflect what the server actually saved (plan-filtered).
    if (result.integrationsSaved) {
      const saved = result.integrationsSaved;
      base.integrations = Object.fromEntries(
        Object.entries(base.integrations).filter(([id]) => saved.includes(id)),
      );
      // Anything detected but not saved was dropped by the plan (a paid
      // integration on a plan without all_integrations). Report it so the user
      // knows to upgrade to enable it.
      base.planBlockedIntegrations = detectedIntegrationIds
        .filter((id) => !saved.includes(id))
        .map((id) => classifyTracker(id).name);
    }
  } catch (err) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Strip trackers from every scanned file ────────────────────────────────
  const changed = new Set<string>();
  const removedTrackerIds = new Set<string>();
  for (const f of files) {
    const r = stripTrackingFromFile(f);
    if (r.changed) changed.add(f);
    for (const id of r.removedTrackerIds ?? []) removedTrackerIds.add(id);
  }

  // Trackers we removed from the code that aren't built-in integrations. They
  // now respect consent, but Consentify can't re-inject them automatically —
  // surface them so the user re-adds them as custom integrations.
  base.unsupportedTrackers = [...removedTrackerIds]
    .map((id) => classifyTracker(id))
    .filter((t) => t.support === "unsupported")
    .map((t) => t.name);

  // ── Inject the Consentify script at the correct spot ──────────────────────
  const injectResults = injectConsentify(
    projectDir,
    base.publicToken as string,
    framework.type,
    framework.entryFiles,
  );
  for (const r of injectResults) {
    if (r.changed) changed.add(r.file);
  }

  base.changedFiles = [...changed].map((f) => relative(projectDir, f));

  // If nothing was injected, the tag never landed. Say so loudly instead of
  // reporting "Updated files" for a set of files we only stripped.
  base.injected = injectResults.some((r) => r.changed);

  // ── Git ───────────────────────────────────────────────────────────────────
  if (ctx.gitMode !== "none") {
    base.git = commitAndPush(projectDir, [...changed], ctx.gitMode);
  }

  base.status = changed.size > 0 ? "success" : "skipped";
  return base;
}
