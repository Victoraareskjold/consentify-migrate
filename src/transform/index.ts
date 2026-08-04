import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, join } from "path";
import type { Framework } from "../detect/framework.js";
import { getCmpRemovalPatterns } from "../detect/cmp.js";
import { blockIsTracker, detectTrackerIds } from "../detect/trackers.js";

export interface TransformResult {
  file: string;
  changed: boolean;
  description: string;
  /** Ids of trackers found (and removed) in this file. */
  removedTrackerIds?: string[];
  /** True when a brand-new file was created (vs. an existing one edited). */
  created?: boolean;
}

// Canonical host (apex redirects to www; avoid a redirect hop on every load).
// Override for local testing, e.g. CONSENTIFY_SCRIPT_HOST=http://localhost:3000
const SCRIPT_HOST = (
  process.env.CONSENTIFY_SCRIPT_HOST ?? "https://www.consentify.app"
).replace(/\/$/, "");

const GATEWAY_URL = (token: string) =>
  `${SCRIPT_HOST}/api/gateway?token=${token}`;

/** Detects that Consentify is already wired up in a piece of content. */
function alreadyHasConsentify(content: string): boolean {
  return content.includes("/api/gateway?token=");
}

// ─── CMP + tracking removal ────────────────────────────────────────────────────

const CMP_PATTERNS = getCmpRemovalPatterns();

/**
 * Remove any known CMP (consent tool) from the content: external script tags
 * pointing at a CMP host, inline blocks containing a CMP signature, WordPress
 * enqueue lines, and standalone CMP data-* attributes. Not Cookiebot-specific.
 */
// Matches a CMP src host anywhere in a block (case-insensitive).
const CMP_SRC_RE = CMP_PATTERNS.srcDomains.length
  ? new RegExp(CMP_PATTERNS.srcDomains.join("|"), "i")
  : null;
// Matches a CMP inline signature anywhere in a block.
const CMP_INLINE_RE = CMP_PATTERNS.inline.length
  ? new RegExp(CMP_PATTERNS.inline.join("|"), "i")
  : null;

/** True when a single <script> block belongs to a known CMP. */
function blockIsCmp(block: string): boolean {
  return (CMP_SRC_RE?.test(block) ?? false) || (CMP_INLINE_RE?.test(block) ?? false);
}

/**
 * Remove CMP leftovers that are NOT <script> blocks: WordPress enqueue lines and
 * standalone data-* attributes. The script blocks themselves are handled by the
 * shared block stripper below.
 */
function removeCmpNonScript(content: string): string {
  const wpSlugs = ["cookiebot", "onetrust", "cookieyes", "cookiefirst", "iubenda", "complianz", "borlabs", "usercentrics", "termly", "osano", "cookie-?script"];
  content = content.replace(
    new RegExp(`^\\s*wp_enqueue_script\\([^)]*(?:${wpSlugs.join("|")})[^)]*\\);\\s*\\n`, "gim"),
    "",
  );

  for (const attr of CMP_PATTERNS.dataAttrs) {
    content = content.replace(
      new RegExp(`^\\s*${attr}=["'][^"']*["']\\s*\\n`, "gim"),
      "",
    );
  }

  return content;
}

/** Should this whole <script>/<Script> block be removed (CMP or tracker)? */
function shouldStripBlock(block: string): boolean {
  return blockIsTracker(block) || blockIsCmp(block);
}

/**
 * Remove every <script>/<Script> block that belongs to a CMP or a tracker,
 * one block at a time.
 *
 * Each block is matched on its own and tested in isolation, which fixes the old
 * greedy behaviour where a block with no signature (e.g. GTM) was either skipped
 * or swallowed together with the next matching block. Self-closing tags are
 * handled by their own pattern; the paired pattern uses a negative lookbehind
 * ((?<!\/)>) so it can never treat a self-closing tag as an opener and eat
 * everything up to the next </script>.
 */
function stripScriptBlocks(content: string): string {
  const passes: RegExp[] = [
    /<Script\b[^>]*\/>/gi, // self-closing JSX <Script … />
    /<Script\b[^>]*?(?<!\/)>[\s\S]*?<\/Script>/gi, // paired JSX <Script>…</Script>
    /<script\b[^>]*\/>/gi, // self-closing HTML <script … />
    /<script\b[^>]*?(?<!\/)>[\s\S]*?<\/script>/gi, // paired HTML <script>…</script>
  ];
  for (const re of passes) {
    content = content.replace(re, (block) =>
      shouldStripBlock(block) ? "" : block,
    );
  }
  return content;
}

/**
 * Remove the GTM <noscript><iframe …></noscript> fallback. Handles both the
 * self-closing JSX form (<iframe … />) and the paired HTML form — the old regex
 * required a literal </iframe> and so left the JSX version behind.
 */
function removeGtmNoscript(content: string): string {
  return content.replace(
    /<noscript>\s*<iframe\b[^>]*googletagmanager\.com[^>]*?(?:\/>|>[\s\S]*?<\/iframe>)\s*<\/noscript>/gi,
    "",
  );
}

function pruneUnusedScriptImport(content: string): string {
  const hasScriptTag = /<Script[\s/>]/i.test(content);
  if (!hasScriptTag) {
    content = content.replace(
      /^import Script from ["']next\/script["'];?\s*\n/m,
      "",
    );
  }
  return content;
}

/**
 * Tidy up the blank space left where blocks were removed: drop trailing
 * whitespace on now-empty lines and collapse runs of blank lines to a single
 * one, so the file reads cleanly instead of showing a gap of empty <head> lines.
 */
function tidyWhitespace(content: string): string {
  return content
    .replace(/[ \t]+(\r?\n)/g, "$1")
    .replace(/(?:\r?\n){3,}/g, "\n\n");
}

/**
 * Strip any existing CMP + third-party tracking scripts from a single file.
 * Applied across every scanned file in a project before the Consentify
 * script is injected — trackers get re-injected by Consentify after consent.
 */
export function stripTrackingFromFile(filePath: string): TransformResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { file: filePath, changed: false, description: "Unreadable, skipped" };
  }

  const original = content;
  const removedTrackerIds = detectTrackerIds(original);

  content = stripScriptBlocks(content);
  content = removeGtmNoscript(content);
  content = removeCmpNonScript(content);

  const ext = extname(filePath).toLowerCase();
  if ([".tsx", ".ts", ".jsx", ".js"].includes(ext)) {
    content = pruneUnusedScriptImport(content);
  }

  if (content !== original) content = tidyWhitespace(content);

  if (content === original) {
    return {
      file: filePath,
      changed: false,
      description: "No trackers found",
      removedTrackerIds,
    };
  }

  writeFileSync(filePath, content, "utf-8");
  return {
    file: filePath,
    changed: true,
    description: "Removed existing consent tool + tracking scripts",
    removedTrackerIds,
  };
}

// ─── Generic HTML injector ────────────────────────────────────────────────────────

function injectIntoHtml(
  filePath: string,
  token: string,
  position: "head" | "body",
): TransformResult {
  let content = readFileSync(filePath, "utf-8");
  if (alreadyHasConsentify(content)) {
    return { file: filePath, changed: false, description: "Consentify already present" };
  }

  const tag = `  <script async src="${GATEWAY_URL(token)}"></script>`;
  const original = content;

  if (position === "head" && /<\/head>/i.test(content)) {
    content = content.replace(/<\/head>/i, `${tag}\n</head>`);
  } else if (/<\/body>/i.test(content)) {
    content = content.replace(/<\/body>/i, `${tag}\n</body>`);
  } else if (/<\/head>/i.test(content)) {
    content = content.replace(/<\/head>/i, `${tag}\n</head>`);
  } else if (/<\/html>/i.test(content)) {
    content = content.replace(/<\/html>/i, `${tag}\n</html>`);
  } else {
    content = `${content}\n${tag}\n`;
  }

  if (content === original) {
    return { file: filePath, changed: false, description: "No injection point found" };
  }
  writeFileSync(filePath, content, "utf-8");
  return {
    file: filePath,
    changed: true,
    description: `Added Consentify <script> (${position})`,
  };
}

// ─── Next.js injectors ────────────────────────────────────────────────────────────

function ensureNextScriptImport(content: string): string {
  if (
    content.includes('from "next/script"') ||
    content.includes("from 'next/script'")
  ) {
    return content;
  }
  const importMatch = content.match(/^import .+$/m);
  if (importMatch) {
    return content.replace(
      importMatch[0],
      `import Script from "next/script";\n${importMatch[0]}`,
    );
  }
  return `import Script from "next/script";\n${content}`;
}

/**
 * App Router: place the script inside the ROOT layout's <body>. Only the
 * root layout has <html>/<body>, so we must not touch nested layouts.
 */
function injectNextAppLayout(filePath: string, token: string): TransformResult {
  let content = readFileSync(filePath, "utf-8");

  if (!/<html[\s>]/i.test(content) || !/<body[\s>]/i.test(content)) {
    return {
      file: filePath,
      changed: false,
      description: "Not a root layout (no <html>/<body>), skipped",
    };
  }
  if (alreadyHasConsentify(content)) {
    return { file: filePath, changed: false, description: "Consentify already present" };
  }

  const tag = `        <Script async src="${GATEWAY_URL(token)}"></Script>`;

  // Insert just before </body> so it lives inside the body, per Next.js docs.
  content = content.replace(/([ \t]*)<\/body>/i, `\n${tag}\n$1</body>`);
  content = ensureNextScriptImport(content);

  writeFileSync(filePath, content, "utf-8");
  return {
    file: filePath,
    changed: true,
    description: "Added Consentify <Script> to root layout <body>",
  };
}

const NEXT_DOCUMENT_TEMPLATE = (token: string) => `import { Html, Head, Main, NextScript } from "next/document";
import Script from "next/script";

export default function Document() {
  return (
    <Html>
      <Head />
      <body>
        <Main />
        <NextScript />
        <Script async src="${GATEWAY_URL(token)}"></Script>
      </body>
    </Html>
  );
}
`;

/**
 * Pages Router: inject into _document if present, otherwise create one.
 * _document is the reliable place for a site-wide script.
 */
function injectNextPages(
  projectDir: string,
  token: string,
  entryFiles: string[],
): TransformResult {
  const documentFile = entryFiles.find((f) => /_document\./.test(f));

  if (documentFile) {
    const abs = join(projectDir, documentFile);
    let content = readFileSync(abs, "utf-8");
    if (alreadyHasConsentify(content)) {
      return { file: abs, changed: false, description: "Consentify already present" };
    }
    const tag = `        <Script async src="${GATEWAY_URL(token)}"></Script>`;
    if (/<\/body>/i.test(content)) {
      content = content.replace(/([ \t]*)<\/body>/i, `${tag}\n$1</body>`);
    } else if (/<NextScript\s*\/>/i.test(content)) {
      content = content.replace(/(<NextScript\s*\/>)/i, `$1\n${tag}`);
    } else {
      return { file: abs, changed: false, description: "Could not find <body>/<NextScript> in _document" };
    }
    content = ensureNextScriptImport(content);
    writeFileSync(abs, content, "utf-8");
    return { file: abs, changed: true, description: "Added Consentify <Script> to _document" };
  }

  // No _document — create one. Detect whether the project uses a src/ dir.
  const usesSrc = existsSync(join(projectDir, "src", "pages"));
  const rel = usesSrc ? "src/pages/_document.tsx" : "pages/_document.tsx";
  const abs = join(projectDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, NEXT_DOCUMENT_TEMPLATE(token), "utf-8");
  return {
    file: abs,
    changed: true,
    created: true,
    description: "Created pages/_document.tsx with Consentify <Script>",
  };
}

// ─── Nuxt injector (generate a client plugin) ─────────────────────────────────────

const NUXT_PLUGIN_TEMPLATE = (token: string) => `// Auto-generated by consentify-migrate.
// Loads the Consentify consent banner on the client.
export default defineNuxtPlugin(() => {
  useHead({
    script: [
      {
        src: "${GATEWAY_URL(token)}",
        async: true,
        tagPosition: "head",
      },
    ],
  });
});
`;

function injectNuxtPlugin(projectDir: string, token: string): TransformResult {
  const rel = "plugins/consentify.client.ts";
  const abs = join(projectDir, rel);
  if (existsSync(abs)) {
    const content = readFileSync(abs, "utf-8");
    if (alreadyHasConsentify(content)) {
      return { file: abs, changed: false, description: "Consentify plugin already present" };
    }
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, NUXT_PLUGIN_TEMPLATE(token), "utf-8");
  return {
    file: abs,
    changed: true,
    created: true,
    description: "Created Nuxt client plugin (plugins/consentify.client.ts)",
  };
}

// ─── Astro injector ───────────────────────────────────────────────────────────────

function injectAstroLayout(filePath: string, token: string): TransformResult {
  let content = readFileSync(filePath, "utf-8");
  if (alreadyHasConsentify(content)) {
    return { file: filePath, changed: false, description: "Consentify already present" };
  }
  if (!/<\/head>/i.test(content)) {
    return { file: filePath, changed: false, description: "No <head> in layout, skipped" };
  }
  const tag = `    <script async src="${GATEWAY_URL(token)}" is:inline></script>`;
  content = content.replace(/([ \t]*)<\/head>/i, `${tag}\n$1</head>`);
  writeFileSync(filePath, content, "utf-8");
  return { file: filePath, changed: true, description: "Added Consentify <script> to Astro layout <head>" };
}

// ─── WordPress injector ───────────────────────────────────────────────────────────

function injectWordpressHeader(filePath: string, token: string): TransformResult {
  let content = readFileSync(filePath, "utf-8");
  if (alreadyHasConsentify(content)) {
    return { file: filePath, changed: false, description: "Consentify already present" };
  }
  const tag = `<script async src="${GATEWAY_URL(token)}"></script>`;

  // Prefer inserting right before wp_head() so it loads early in <head>.
  if (/<\?php\s+wp_head\(\s*\)\s*;?\s*\?>/.test(content)) {
    content = content.replace(
      /(<\?php\s+wp_head\(\s*\)\s*;?\s*\?>)/,
      `${tag}\n$1`,
    );
  } else if (/<\/head>/i.test(content)) {
    content = content.replace(/<\/head>/i, `${tag}\n</head>`);
  } else {
    return { file: filePath, changed: false, description: "No wp_head()/</head> found" };
  }
  writeFileSync(filePath, content, "utf-8");
  return { file: filePath, changed: true, description: "Added Consentify <script> to header.php" };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────────

/**
 * Inject the Consentify script into a project using the correct strategy for
 * its framework. Returns one result per file touched/created.
 */
export function injectConsentify(
  projectDir: string,
  token: string,
  framework: Framework,
  entryFiles: string[],
): TransformResult[] {
  const abs = (rel: string) => join(projectDir, rel);

  switch (framework) {
    case "nextjs-app": {
      if (!entryFiles.length) {
        return [{ file: projectDir, changed: false, description: "No root layout found" }];
      }
      return [injectNextAppLayout(abs(entryFiles[0]), token)];
    }
    case "nextjs-pages":
      return [injectNextPages(projectDir, token, entryFiles)];
    case "nuxt":
      return [injectNuxtPlugin(projectDir, token)];
    case "sveltekit": {
      if (!entryFiles.length) {
        return [{ file: projectDir, changed: false, description: "No src/app.html found" }];
      }
      return [injectIntoHtml(abs(entryFiles[0]), token, "body")];
    }
    case "astro": {
      if (!entryFiles.length) {
        return [{ file: projectDir, changed: false, description: "No Astro layout with <head> found" }];
      }
      return [injectAstroLayout(abs(entryFiles[0]), token)];
    }
    case "wordpress": {
      if (!entryFiles.length) {
        return [{ file: projectDir, changed: false, description: "No theme header.php found" }];
      }
      return [injectWordpressHeader(abs(entryFiles[0]), token)];
    }
    case "vue":
    case "svelte":
    case "angular": {
      if (!entryFiles.length) {
        return [{ file: projectDir, changed: false, description: "No index.html found" }];
      }
      return [injectIntoHtml(abs(entryFiles[0]), token, "head")];
    }
    case "react":
    case "html": {
      if (!entryFiles.length) {
        return [{ file: projectDir, changed: false, description: "No index.html found" }];
      }
      return [injectIntoHtml(abs(entryFiles[0]), token, "body")];
    }
    default:
      return [
        {
          file: projectDir,
          changed: false,
          description: "Unknown framework — add the script tag manually",
        },
      ];
  }
}
