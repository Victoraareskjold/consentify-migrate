import { writeFileSync } from "fs";
import { basename, join } from "path";
import type { ProjectResult } from "../process.js";

export interface ReportPaths {
  markdown: string;
  json: string;
}

function statusIcon(s: ProjectResult["status"]): string {
  return s === "success" ? "✅" : s === "skipped" ? "⏭️" : "❌";
}

/**
 * Write a Markdown + JSON migration report to `dir`. Essential when running
 * across dozens or hundreds of sites — it's the record of what happened,
 * which tokens were issued, and what still needs manual attention.
 */
export function writeReport(
  dir: string,
  results: ProjectResult[],
  meta: { dryRun: boolean; startedAt: string },
): ReportPaths {
  const ok = results.filter((r) => r.status === "success").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errored = results.filter((r) => r.status === "error").length;

  const lines: string[] = [];
  lines.push(`# Consentify migration report`);
  lines.push("");
  lines.push(`- Run at: ${meta.startedAt}`);
  lines.push(`- Mode: ${meta.dryRun ? "dry run (no changes made)" : "live"}`);
  lines.push(`- Projects: ${results.length}`);
  lines.push(`- ✅ Success: ${ok}  ⏭️ Skipped: ${skipped}  ❌ Errors: ${errored}`);
  lines.push("");
  lines.push(
    `| Project | Framework | Domain | Status | Public token | Integrations | Git |`,
  );
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);

  for (const r of results) {
    const integ = Object.keys(r.integrations).length
      ? Object.keys(r.integrations).join(", ")
      : "—";
    const gitMsg = r.git ? r.git.message : "—";
    lines.push(
      `| ${basename(r.dir)} | ${r.frameworkLabel} | ${r.domain} | ${statusIcon(
        r.status,
      )} ${r.status} | ${r.publicToken ?? "—"} | ${integ} | ${gitMsg} |`,
    );
  }

  // Detail on anything needing manual follow-up.
  const followUps = results.filter(
    (r) =>
      r.status === "error" ||
      r.integrationsNeedingManual.length > 0 ||
      r.planBlockedIntegrations.length > 0 ||
      r.unsupportedTrackers.length > 0,
  );
  if (followUps.length) {
    lines.push("");
    lines.push(`## Needs attention`);
    lines.push("");
    for (const r of followUps) {
      lines.push(`### ${basename(r.dir)} (${r.domain})`);
      if (r.error) lines.push(`- Error: ${r.error}`);
      if (r.integrationsNeedingManual.length) {
        lines.push(
          `- Configure manually in dashboard: ${r.integrationsNeedingManual.join(", ")}`,
        );
      }
      if (r.planBlockedIntegrations.length) {
        lines.push(
          `- Detected but not on your plan (upgrade to enable): ${r.planBlockedIntegrations.join(", ")}`,
        );
      }
      if (r.unsupportedTrackers.length) {
        lines.push(
          `- Removed but not a built-in integration (re-add as a custom integration): ${r.unsupportedTrackers.join(", ")}`,
        );
      }
      lines.push("");
    }
  }

  const markdown = join(dir, "consentify-migration-report.md");
  const json = join(dir, "consentify-migration-report.json");
  writeFileSync(markdown, lines.join("\n"), "utf-8");
  writeFileSync(
    json,
    JSON.stringify({ meta, summary: { ok, skipped, errored }, results }, null, 2),
    "utf-8",
  );
  return { markdown, json };
}
