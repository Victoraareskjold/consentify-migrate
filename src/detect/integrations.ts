import { readFileSync } from "fs";

import {
  TRACKERS,
  classifyTracker,
  extractSupportedIds,
} from "./trackers.js";

export interface DetectedIntegration {
  id: string;
  name: string;
  trackingId: string | null;
}

/**
 * Scan a single file for Consentify-supported integrations, using the shared
 * tracker registry as the single source of truth. Only integrations that are
 * live in the app are returned here; unsupported trackers are reported
 * separately (they get stripped but can't be auto-configured).
 */
export function scanFileForIntegrations(
  filePath: string,
): DetectedIntegration[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const ids = extractSupportedIds(content);
  const found: DetectedIntegration[] = [];

  for (const t of TRACKERS) {
    const { name, support } = classifyTracker(t.id);
    if (support === "unsupported") continue;
    if (!t.match.test(content)) continue;
    found.push({ id: t.id, name, trackingId: ids[t.id] ?? null });
  }

  return found;
}

/**
 * Merges integration results from multiple files.
 * If the same integration appears in multiple files, the first
 * non-null trackingId wins.
 */
export function mergeIntegrations(
  results: DetectedIntegration[][],
): DetectedIntegration[] {
  const map = new Map<string, DetectedIntegration>();

  for (const fileResults of results) {
    for (const integration of fileResults) {
      const existing = map.get(integration.id);
      if (!existing) {
        map.set(integration.id, { ...integration });
      } else if (existing.trackingId === null && integration.trackingId) {
        map.set(integration.id, {
          ...existing,
          trackingId: integration.trackingId,
        });
      }
    }
  }

  return Array.from(map.values());
}
