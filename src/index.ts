import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import { spawn } from "child_process";

import { startCliAuth, pollCliAuth } from "./api.js";
import { isGitRepo, hasRemote, currentBranch } from "./git/index.js";

// Canonical host (apex redirects to www; avoid a redirect hop on every load).
// Override for local testing, e.g. CONSENTIFY_SCRIPT_HOST=http://localhost:3000
const SCRIPT_HOST = "https://www.consentify.app".replace(/\/$/, "");
import { processProject } from "./process.js";
import { runBulk } from "./bulk/index.js";
import type { GitMode } from "./git/index.js";
import {
  header,
  step,
  info,
  success,
  warn,
  fail,
  DIVIDER,
  normalizeDomain,
  looksLikeDomain,
  brief,
} from "./ui.js";

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface CliArgs {
  bulk: boolean;
  dir: string;
  gitMode: GitMode;
  /** True when git mode was set via a flag, so we skip the interactive prompt. */
  gitExplicit: boolean;
  dryRun: boolean;
  yes: boolean;
  useScanner: boolean;
  manifestPath?: string;
  policyPattern?: string;
  /** Single-project mode: domain passed as a positional, skips the prompt. */
  domain?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    bulk: false,
    dir: process.cwd(),
    gitMode: "branch",
    gitExplicit: false,
    dryRun: false,
    yes: false,
    useScanner: true,
  };

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "bulk" || a === "--all" || a === "--bulk") {
      args.bulk = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--yes" || a === "-y") {
      args.yes = true;
    } else if (a === "--no-scan") {
      args.useScanner = false;
    } else if (a.startsWith("--git=")) {
      args.gitMode = a.slice("--git=".length) as GitMode;
      args.gitExplicit = true;
    } else if (a === "--git") {
      args.gitMode = (argv[++i] as GitMode) ?? "branch";
      args.gitExplicit = true;
    } else if (a.startsWith("--manifest=")) {
      args.manifestPath = a.slice("--manifest=".length);
    } else if (a === "--manifest") {
      args.manifestPath = argv[++i];
    } else if (a.startsWith("--dir=")) {
      args.dir = a.slice("--dir=".length);
    } else if (a === "--dir") {
      args.dir = argv[++i];
    } else if (a.startsWith("--policy-pattern=")) {
      args.policyPattern = a.slice("--policy-pattern=".length);
    } else if (a === "--policy-pattern") {
      args.policyPattern = argv[++i];
    } else if (!a.startsWith("-")) {
      positionals.push(a);
    }
  }

  // `bulk <dir>` or `--dir <dir>` or a bare path positional in bulk mode.
  if (args.bulk && positionals.length) {
    args.dir = positionals[positionals.length - 1];
  } else if (!args.bulk && positionals.length) {
    // Single-project mode: a bare positional is the domain, e.g.
    // `npx consentify-migrate example.com`. This is what the scan page prefills
    // so the user doesn't have to retype the site they just scanned.
    const first = positionals[0];

    // A path is not a domain. Without this guard `consentify-migrate ./clients`
    // normalizes to the domain "." and then walks every subfolder, stripping
    // trackers out of projects it was never pointed at.
    const isDir = (() => {
      try {
        return existsSync(first) && statSync(first).isDirectory();
      } catch {
        return false;
      }
    })();

    if (isDir) {
      console.error(
        chalk.red(`\n  "${first}" is a folder, not a domain.\n`) +
          chalk.dim("  To set up every project inside it, use bulk mode:\n\n") +
          chalk.bold(`    npx consentify-migrate bulk ${first}\n\n`) +
          chalk.dim(
            "  To set up a single project, run this from that project's root.\n",
          ),
      );
      process.exit(1);
    }

    if (!looksLikeDomain(normalizeDomain(first))) {
      console.error(
        chalk.red(`\n  "${first}" doesn't look like a domain.\n`) +
          chalk.dim("  Expected something like: ") +
          chalk.bold("npx consentify-migrate example.com\n"),
      );
      process.exit(1);
    }

    args.domain = first;
  }

  const validGit: GitMode[] = ["branch", "push", "commit", "none"];
  if (!validGit.includes(args.gitMode)) args.gitMode = "branch";

  args.dir = resolve(args.dir);
  return args;
}

// ─── Login + team selection (shared) ──────────────────────────────────────────

/** Open a URL in the user's default browser, cross-platform. Best-effort. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Ignore — we always print the URL as a fallback.
  }
}

async function authenticate(): Promise<{
  accessToken: string;
  teamId: string;
}> {
  step("Log in to Consentify");

  const startSpinner = ora("Preparing login").start();
  let auth;
  try {
    auth = await startCliAuth();
    startSpinner.stop();
  } catch (err) {
    startSpinner.fail("Could not start login");
    console.error(
      chalk.red(`  ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  info("Opening your browser to log in with GitHub or Google…");
  console.log(
    chalk.dim(`  If it doesn't open, visit:\n  ${chalk.cyan(auth.authUrl)}\n`),
  );
  openBrowser(auth.authUrl);

  const spinner = ora("Waiting for login in your browser").start();
  try {
    const { accessToken, teamId } = await pollCliAuth(auth.pollUrl);
    spinner.succeed("Logged in");
    return { accessToken, teamId };
  } catch (err) {
    spinner.fail("Login failed");
    console.error(
      chalk.red(`  ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }
}

/**
 * Ask how the file changes should be handled in git. Skipped when the mode was
 * passed as a flag, in --yes mode, on a dry run, or when the folder isn't a git
 * repo (nothing to commit to, so we just edit the files).
 */
async function resolveGitMode(args: CliArgs): Promise<GitMode> {
  if (args.dryRun || args.gitExplicit || args.yes) return args.gitMode;
  if (!isGitRepo(args.dir)) return "none";

  const branch = currentBranch(args.dir) ?? "current branch";
  // Two choices only. `--git=commit` and `--git=push` still work as flags for
  // anyone who wants them; a four-item menu just slows everyone else down.
  void branch;
  void hasRemote;
  const choices: { name: string; value: GitMode }[] = [
    {
      name: "Commit on a new branch (consentify-setup) (recommended)",
      value: "branch",
    },
    { name: "Just edit the files, I'll commit myself", value: "none" },
  ];

  return select<GitMode>({
    message: "How should I handle git?",
    choices,
    default: "branch",
  });
}

// ─── Single-project flow ──────────────────────────────────────────────────────

async function runSingle(args: CliArgs) {
  // Dry run makes no API calls, so it doesn't need a login.
  const { accessToken, teamId } = args.dryRun
    ? { accessToken: "", teamId: "" }
    : await authenticate();

  console.log();
  let domain: string;
  if (args.domain) {
    // Passed as an argument (e.g. from the scan page) — skip the prompt.
    domain = normalizeDomain(args.domain);
    info(`Domain: ${chalk.bold(domain)}`);
  } else {
    const rawDomain = await input({
      message: "Your domain (e.g. example.com):",
      validate: (v) =>
        looksLikeDomain(normalizeDomain(v))
          ? true
          : "Enter a valid domain, e.g. example.com",
    });
    domain = normalizeDomain(rawDomain);
  }
  if (!looksLikeDomain(domain)) {
    fail(`"${domain}" doesn't look like a domain.`);
    process.exit(1);
  }
  // The policy URL is auto-detected from the project's routes. Anyone who needs
  // to override it can pass --policy-pattern, so this prompt earned nothing.
  const policyUrl = "";

  args.gitMode = await resolveGitMode(args);

  console.log();
  console.log(DIVIDER);
  step("Setting up Consentify…");

  const spinner = ora(
    args.useScanner ? "Scanning site + setting up" : "Setting up",
  ).start();
  const result = await processProject(args.dir, {
    accessToken,
    teamId,
    domain,
    policyUrlExplicit: policyUrl.trim() || undefined,
    policyPattern: args.policyPattern,
    useScanner: args.useScanner,
    gitMode: args.gitMode,
    dryRun: args.dryRun,
  });
  spinner.stop();

  if (result.status === "error") {
    fail(result.error ?? "Setup failed");
    process.exit(1);
  }

  success(
    `Detected ${chalk.bold(result.frameworkLabel)} — ${result.placement}`,
  );
  if (result.scanError) {
    warn(`Live scan unavailable (${result.scanError}); used code detection.`);
  }
  if (result.policyUrl) info(`Privacy policy: ${result.policyUrl}`);
  if (result.detectedCmps.length) {
    const n = result.cmpFiles.length;
    info(
      `Removed ${result.detectedCmps.join(", ")} from ${n} file${n === 1 ? "" : "s"}`,
    );
  } else {
    info("No existing consent tool found — setting up Consentify fresh.");
  }
  if (Object.keys(result.integrations).length) {
    success(
      `Integrations: ${brief(Object.keys(result.integrations), 5)} (via ${result.detectionSource})`,
    );
  }
  if (result.integrationsNeedingManual.length) {
    warn(`Configure manually in dashboard: ${brief(result.integrationsNeedingManual)}`);
  }
  if (result.planBlockedIntegrations.length) {
    warn(`Not on your plan (upgrade to enable): ${brief(result.planBlockedIntegrations)}`);
  }
  if (result.unsupportedTrackers.length) {
    warn(
      `Not built-in, re-add as custom integrations: ${brief(result.unsupportedTrackers)}`,
    );
  }
  if (result.changedFiles.length) {
    const n = result.changedFiles.length;
    success(
      `Updated ${n} file${n === 1 ? "" : "s"}: ${brief(result.changedFiles)}`,
    );
  } else {
    warn("No files were modified. Add the script tag manually.");
  }
  if (result.changedFiles.length && !result.injected) {
    warn(
      "The Consentify tag was NOT injected — no entry point was found. " +
        "Trackers were removed, so add the tag manually before deploying.",
    );
  }
  if (result.git) info(`Git: ${result.git.message}`);

  console.log();
  console.log(chalk.bold.green("✅ Migration complete!"));
  if (result.publicToken) {
    console.log(chalk.bold("\nYour Consentify script tag:"));
    console.log(
      chalk.bgBlack.white(
        `\n  <script src="${SCRIPT_HOST}/api/gateway?token=${result.publicToken}"></script>\n`,
      ),
    );
  }
  info(
    `Customize your banner at ${chalk.cyan("https://consentify.app/dashboard/banner")}`,
  );
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  header();
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log(
      chalk.yellow("  Dry run — detecting only, no changes will be made.\n"),
    );
  }
  console.log(chalk.dim(`  Git mode: ${args.gitMode}\n`));

  if (args.bulk) {
    console.log(
      chalk.dim(
        "  Bulk mode — every project inside the folder will be set up.\n",
      ),
    );
    // Dry run makes no API calls, so it doesn't need a login.
    const { accessToken, teamId } = args.dryRun
      ? { accessToken: "", teamId: "" }
      : await authenticate();
    await runBulk(args.dir, {
      accessToken,
      teamId,
      gitMode: args.gitMode,
      gitExplicit: args.gitExplicit,
      dryRun: args.dryRun,
      yes: args.yes,
      useScanner: args.useScanner,
      manifestPath: args.manifestPath,
      policyPattern: args.policyPattern,
    });
    return;
  }

  await runSingle(args);
}

main().catch((err) => {
  console.error(chalk.red("\nUnexpected error:"), err);
  process.exit(1);
});
