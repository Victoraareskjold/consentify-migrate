import chalk from "chalk";

export const DIVIDER = chalk.dim("─".repeat(56));

export function header() {
  console.log();
  console.log(chalk.bold.green("🍪 Consentify Migration Tool"));
  console.log(DIVIDER);
}

export function step(msg: string) {
  console.log(`\n${chalk.bold(msg)}`);
}

export function info(msg: string) {
  console.log(`  ${chalk.cyan("•")} ${msg}`);
}

export function success(msg: string) {
  console.log(`  ${chalk.green("✓")} ${msg}`);
}

export function warn(msg: string) {
  console.log(`  ${chalk.yellow("⚠")} ${msg}`);
}

export function fail(msg: string) {
  console.log(`  ${chalk.red("✗")} ${msg}`);
}

export function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .trim()
    .toLowerCase();
}

/** A string looks like a domain if it has a dot and a plausible TLD. */
export function looksLikeDomain(s: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s.trim());
}

/**
 * Join a list for display, capped so a run over 100 projects stays readable.
 * Full detail always lands in the report file, so nothing is lost here.
 */
export function brief(items: string[], max = 3): string {
  if (items.length === 0) return "none";
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}
