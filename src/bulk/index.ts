import { readdirSync, statSync, existsSync } from "fs";
import { basename, join, relative } from "path";
import { execFileSync } from "child_process";
import { input, confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";

import { detectFramework, looksLikeProject } from "../detect/framework.js";
import { processProject, type ProjectResult } from "../process.js";
import type { GitMode } from "../git/index.js";
import { getCapacity } from "../api.js";
import { loadManifest, type Manifest } from "./manifest.js";
import { writeReport } from "./report.js";
import {
  DIVIDER,
  info,
  success,
  warn,
  fail,
  step,
  normalizeDomain,
  looksLikeDomain,
} from "../ui.js";

export interface BulkOptions {
  accessToken: string;
  teamId: string;
  gitMode: GitMode;
  dryRun: boolean;
  /** Skip all prompts; unresolved domains are skipped. */
  yes: boolean;
  useScanner: boolean;
  manifestPath?: string;
  policyPattern?: string; // e.g. "https://{domain}/privacy"
  /** True when git mode came from a flag, so we skip the interactive prompt. */
  gitExplicit?: boolean;
}

interface Candidate {
  dir: string;
  name: string;
}

/** Immediate subdirectories of `parent` that look like projects. */
function findProjects(parent: string): Candidate[] {
  const out: Candidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules") continue;
    const dir = join(parent, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (looksLikeProject(dir)) out.push({ dir, name });
  }
  return out;
}

/** Try to read a domain from the project's git remote (best effort). */
function domainFromGitRemote(dir: string): string | null {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // We only trust it if the repo name itself is a domain (e.g. example.com.git)
    const repo = url.replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
    return looksLikeDomain(repo) ? normalizeDomain(repo) : null;
  } catch {
    return null;
  }
}

function resolveDomain(
  cand: Candidate,
  manifest: Manifest | null,
): { domain: string | null; policyUrl?: string } {
  const m = manifest?.get(cand.name);
  if (m) return { domain: normalizeDomain(m.domain), policyUrl: m.policyUrl };

  // Folder name that is itself a domain (e.g. "acme.com")
  if (looksLikeDomain(cand.name)) return { domain: normalizeDomain(cand.name) };

  // Git remote fallback
  const fromGit = domainFromGitRemote(cand.dir);
  if (fromGit) return { domain: fromGit };

  return { domain: null };
}

export async function runBulk(
  parentDir: string,
  opts: BulkOptions,
): Promise<void> {
  step(`Scanning ${chalk.cyan(parentDir)} for projects…`);

  const candidates = findProjects(parentDir);
  if (candidates.length === 0) {
    fail("No projects found in that folder.");
    warn(
      "Point the tool at a folder whose immediate subfolders are the sites (each with a package.json, index.html, or WordPress theme).",
    );
    return;
  }

  const manifest = opts.manifestPath ? loadManifest(opts.manifestPath) : null;
  if (manifest) success(`Loaded manifest with ${manifest.size} mapping(s)`);

  // Build the plan: framework + resolved domain per project.
  interface Planned extends Candidate {
    domain: string | null;
    policyUrl?: string;
    frameworkLabel: string;
    placement: string;
  }

  const planned: Planned[] = candidates.map((c) => {
    const fw = detectFramework(c.dir);
    const { domain, policyUrl } = resolveDomain(c, manifest);
    return {
      ...c,
      domain,
      policyUrl,
      frameworkLabel: fw.label,
      placement: fw.placement,
    };
  });

  // Show the plan.
  console.log();
  console.log(DIVIDER);
  console.log(chalk.bold(`Found ${planned.length} project(s):\n`));
  for (const p of planned) {
    const domainLabel = p.domain
      ? chalk.green(p.domain)
      : chalk.yellow("(domain needed)");
    info(
      `${chalk.bold(p.name)}  ${chalk.dim("→")} ${p.frameworkLabel}  ${chalk.dim(
        "·",
      )} ${domainLabel}`,
    );
    console.log(`      ${chalk.dim(p.placement)}`);
  }
  console.log();

  // Resolve missing domains interactively (unless --yes).
  for (const p of planned) {
    if (p.domain) continue;
    if (opts.yes) {
      warn(`${p.name}: no domain resolved — skipping (provide a manifest).`);
      continue;
    }
    const answer = await input({
      message: `Domain for ${chalk.bold(p.name)} (leave blank to skip):`,
    });
    if (answer.trim()) p.domain = normalizeDomain(answer);
  }

  let toProcess = planned.filter((p) => p.domain);
  if (toProcess.length === 0) {
    fail("No projects have a domain to set up. Nothing to do.");
    return;
  }

  // ── Capacity precheck ───────────────────────────────────────────────────────
  // Stop early (or trim) if the team doesn't have room for this many domains,
  // instead of failing one-by-one partway through a 200-site run.
  const overflow: Planned[] = [];
  if (!opts.dryRun) {
    try {
      const cap = await getCapacity(opts.accessToken, opts.teamId);
      if (cap.remaining !== null) {
        info(
          `Plan capacity: ${cap.used}/${cap.domainCapacity} domains used, ${chalk.bold(
            String(cap.remaining),
          )} remaining.`,
        );
        if (toProcess.length > cap.remaining) {
          warn(
            `You're trying to set up ${toProcess.length} sites but only ${cap.remaining} slot(s) remain.`,
          );
          if (cap.remaining === 0) {
            fail("No domain capacity left. Increase capacity and re-run.");
            return;
          }
          if (opts.yes) {
            overflow.push(...toProcess.slice(cap.remaining));
            toProcess = toProcess.slice(0, cap.remaining);
            warn(
              `Proceeding with the first ${toProcess.length}; ${overflow.length} will be reported as skipped (over capacity).`,
            );
          } else {
            const proceed = await confirm({
              message: `Set up the first ${cap.remaining} and skip the rest?`,
              default: true,
            });
            if (!proceed) {
              warn("Aborted. Increase capacity and re-run to do them all.");
              return;
            }
            overflow.push(...toProcess.slice(cap.remaining));
            toProcess = toProcess.slice(0, cap.remaining);
          }
        }
      } else {
        info("Plan capacity: unlimited domains.");
      }
    } catch (err) {
      warn(
        `Could not check plan capacity (${err instanceof Error ? err.message : String(err)}); continuing.`,
      );
    }
  }

  if (!opts.yes && !opts.dryRun) {
    console.log();
    const go = await confirm({
      message: `Set up Consentify on ${chalk.bold(
        String(toProcess.length),
      )} project(s)?`,
      default: true,
    });
    if (!go) {
      warn("Aborted.");
      return;
    }

    // Git is its own decision. Bundled into the confirm above, declining the
    // push also meant declining the whole run.
    if (!opts.gitExplicit) {
      opts.gitMode = await select<GitMode>({
        message: "How should I handle git?",
        choices: [
          {
            name: "Commit on a new branch and push (recommended)",
            value: "branch",
          },
          { name: "Just edit the files, I'll commit myself", value: "none" },
        ],
        default: "branch",
      });
    }
  }

  // Process sequentially, continue on error.
  const results: ProjectResult[] = [];
  const startedAt = new Date().toISOString();

  let idx = 0;
  for (const p of toProcess) {
    idx++;
    const label = `[${idx}/${toProcess.length}] ${p.name} → ${p.domain}`;
    const spinner = ora(label).start();
    try {
      const result = await processProject(p.dir, {
        accessToken: opts.accessToken,
        teamId: opts.teamId,
        domain: p.domain as string,
        policyUrlExplicit: p.policyUrl,
        policyPattern: opts.policyPattern,
        useScanner: opts.useScanner,
        gitMode: opts.gitMode,
        dryRun: opts.dryRun,
      });
      results.push(result);

      if (result.status === "error") {
        spinner.fail(`${label} — ${result.error}`);
      } else if (result.status === "skipped") {
        spinner.warn(`${label} — ${opts.dryRun ? "planned" : "no changes"}`);
      } else {
        const git = result.git ? ` · ${result.git.message}` : "";
        spinner.succeed(`${label}${chalk.dim(git)}`);
      }
    } catch (err) {
      spinner.fail(`${label} — unexpected error`);
      results.push({
        dir: p.dir,
        domain: p.domain as string,
        framework: "unknown",
        frameworkLabel: p.frameworkLabel,
        placement: p.placement,
        status: "error",
        detectionSource: "none",
        integrations: {},
        integrationsNeedingManual: [],
        unsupportedTrackers: [],
        planBlockedIntegrations: [],
        detectedCmps: [],
        cmpFiles: [],
        changedFiles: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Record projects skipped for lack of domain capacity so they show in the report.
  for (const p of overflow) {
    results.push({
      dir: p.dir,
      domain: p.domain as string,
      framework: "unknown",
      frameworkLabel: p.frameworkLabel,
      placement: p.placement,
      status: "skipped",
      detectionSource: "none",
      integrations: {},
      integrationsNeedingManual: [],
      unsupportedTrackers: [],
      planBlockedIntegrations: [],
      detectedCmps: [],
      cmpFiles: [],
      changedFiles: [],
      error: "Skipped: over plan domain capacity",
    });
  }

  // Report.
  const paths = writeReport(parentDir, results, { dryRun: opts.dryRun, startedAt });

  console.log();
  console.log(DIVIDER);
  const ok = results.filter((r) => r.status === "success").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errored = results.filter((r) => r.status === "error").length;
  console.log(
    chalk.bold(
      `\nDone. ${chalk.green(`${ok} succeeded`)}, ${chalk.yellow(
        `${skipped} skipped`,
      )}, ${errored ? chalk.red(`${errored} errored`) : `${errored} errored`}.`,
    ),
  );
  success(`Report: ${relative(process.cwd(), paths.markdown)}`);
  if (existsSync(paths.json)) {
    info(chalk.dim(`JSON:   ${relative(process.cwd(), paths.json)}`));
  }
  console.log();
}
