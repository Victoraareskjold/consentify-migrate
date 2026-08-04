import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Every framework we know how to install Consentify into.
 * The `type` drives which injector (see ../transform) is used, so the
 * script lands in the *correct* place for that stack (e.g. the Next.js
 * root layout, the SvelteKit app.html, a Nuxt plugin, etc).
 */
export type Framework =
  | "nextjs-app" // Next.js App Router (app/layout.tsx)
  | "nextjs-pages" // Next.js Pages Router (pages/_app or _document)
  | "react" // CRA / Vite React SPA (index.html)
  | "vue" // Vue SPA via Vite (index.html)
  | "nuxt" // Nuxt 3 (generate a client plugin)
  | "sveltekit" // SvelteKit (src/app.html)
  | "svelte" // Svelte SPA via Vite (index.html)
  | "astro" // Astro (base layout in src/layouts)
  | "angular" // Angular (src/index.html)
  | "wordpress" // WordPress theme (header.php)
  | "html" // Plain static HTML
  | "unknown";

export interface FrameworkResult {
  type: Framework;
  label: string;
  /** Globs used to scan for existing CMPs + tracking scripts to strip. */
  searchGlobs: string[];
  /**
   * Concrete entry files (relative to project root) the injector should
   * target. Order matters — the injector uses the first suitable one.
   */
  entryFiles: string[];
  /**
   * Short human note on where the script gets placed. Shown in the CLI
   * so the operator understands what will happen per project.
   */
  placement: string;
}

// ─── Small fs helpers ───────────────────────────────────────────────────────────

function has(cwd: string, rel: string): boolean {
  return existsSync(join(cwd, rel));
}

function firstExisting(cwd: string, candidates: string[]): string[] {
  for (const c of candidates) {
    if (has(cwd, c)) return [c];
  }
  return [];
}

function readPkg(cwd: string): {
  deps: Record<string, string>;
  raw: Record<string, unknown>;
} | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const deps = {
      ...(raw.dependencies as Record<string, string> | undefined),
      ...(raw.devDependencies as Record<string, string> | undefined),
    };
    return { deps, raw };
  } catch {
    return null;
  }
}

/** Does a Next.js project use the App Router (has app/layout.*)? */
function findNextRootLayout(cwd: string): string[] {
  const candidates = [
    "app/layout.tsx",
    "app/layout.jsx",
    "app/layout.ts",
    "app/layout.js",
    "src/app/layout.tsx",
    "src/app/layout.jsx",
    "src/app/layout.ts",
    "src/app/layout.js",
  ];
  return firstExisting(cwd, candidates);
}

function findNextPagesEntry(cwd: string): string[] {
  const files: string[] = [];
  const appCandidates = [
    "pages/_app.tsx",
    "pages/_app.jsx",
    "pages/_app.ts",
    "pages/_app.js",
    "src/pages/_app.tsx",
    "src/pages/_app.jsx",
  ];
  const docCandidates = [
    "pages/_document.tsx",
    "pages/_document.jsx",
    "pages/_document.ts",
    "pages/_document.js",
    "src/pages/_document.tsx",
    "src/pages/_document.jsx",
  ];
  files.push(...firstExisting(cwd, appCandidates));
  files.push(...firstExisting(cwd, docCandidates));
  return files;
}

/** Find an Astro base layout (a .astro file that contains <html> and <head>). */
function findAstroLayout(cwd: string): string[] {
  const dirs = ["src/layouts", "src/components", "src/pages"];
  for (const dir of dirs) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) continue;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".astro")) continue;
      const rel = `${dir}/${name}`;
      try {
        const content = readFileSync(join(cwd, rel), "utf-8");
        if (/<head[\s>]/i.test(content) && /<html[\s>]/i.test(content)) {
          return [rel];
        }
      } catch {
        /* ignore */
      }
    }
  }
  // Fall back to the root index page if no layout with <head> was found.
  return firstExisting(cwd, ["src/pages/index.astro"]);
}

/** Find the active WordPress theme's header.php. */
function findWordpressHeader(cwd: string): string[] {
  // Common locations for a single theme checked out on its own.
  const direct = firstExisting(cwd, [
    "header.php",
    "wp-content/themes/header.php",
  ]);
  if (direct.length) return direct;

  const themesDir = join(cwd, "wp-content/themes");
  if (existsSync(themesDir)) {
    try {
      for (const theme of readdirSync(themesDir)) {
        const rel = `wp-content/themes/${theme}/header.php`;
        if (has(cwd, rel)) return [rel];
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

// ─── Main detection ─────────────────────────────────────────────────────────────

export function detectFramework(cwd: string): FrameworkResult {
  const pkg = readPkg(cwd);
  const deps = pkg?.deps ?? {};

  const jsGlobs = [
    "app/**/*.{tsx,ts,jsx,js}",
    "src/**/*.{tsx,ts,jsx,js,vue,svelte,astro}",
    "pages/**/*.{tsx,ts,jsx,js}",
    "components/**/*.{tsx,ts,jsx,js,vue,svelte}",
    "layouts/**/*.{tsx,ts,jsx,js,vue,svelte}",
    "public/**/*.html",
    "index.html",
    "*.html",
  ];

  if (pkg) {
    // ── Nuxt (check before Vue: Nuxt depends on vue) ───────────────────────────
    if ("nuxt" in deps || "nuxt3" in deps || has(cwd, "nuxt.config.ts") || has(cwd, "nuxt.config.js")) {
      return {
        type: "nuxt",
        label: "Nuxt",
        searchGlobs: jsGlobs,
        // We generate a client plugin, so no existing entry file is required.
        entryFiles: firstExisting(cwd, ["app.vue"]),
        placement: "New client plugin (plugins/consentify.client.ts) via useHead",
      };
    }

    // ── SvelteKit (check before plain Svelte) ──────────────────────────────────
    if ("@sveltejs/kit" in deps) {
      return {
        type: "sveltekit",
        label: "SvelteKit",
        searchGlobs: jsGlobs,
        entryFiles: firstExisting(cwd, ["src/app.html"]),
        placement: "src/app.html (before </body>)",
      };
    }

    // ── Astro ──────────────────────────────────────────────────────────────────
    if ("astro" in deps) {
      return {
        type: "astro",
        label: "Astro",
        searchGlobs: jsGlobs,
        entryFiles: findAstroLayout(cwd),
        placement: "Base layout (before </head>)",
      };
    }

    // ── Angular ────────────────────────────────────────────────────────────────
    if ("@angular/core" in deps || has(cwd, "angular.json")) {
      return {
        type: "angular",
        label: "Angular",
        searchGlobs: ["src/**/*.{ts,html}", "src/index.html"],
        entryFiles: firstExisting(cwd, ["src/index.html"]),
        placement: "src/index.html (before </head>)",
      };
    }

    // ── Next.js ────────────────────────────────────────────────────────────────
    if ("next" in deps) {
      const rootLayout = findNextRootLayout(cwd);
      if (rootLayout.length) {
        return {
          type: "nextjs-app",
          label: "Next.js (App Router)",
          searchGlobs: jsGlobs,
          entryFiles: rootLayout,
          placement: "Root layout <body> via next/script",
        };
      }
      return {
        type: "nextjs-pages",
        label: "Next.js (Pages Router)",
        searchGlobs: jsGlobs,
        entryFiles: findNextPagesEntry(cwd),
        placement: "pages/_app or _document via next/script",
      };
    }

    // ── Vue SPA (Vite) ─────────────────────────────────────────────────────────
    if ("vue" in deps) {
      return {
        type: "vue",
        label: "Vue",
        searchGlobs: jsGlobs,
        entryFiles: firstExisting(cwd, ["index.html", "public/index.html"]),
        placement: "index.html (before </head>)",
      };
    }

    // ── Svelte SPA (Vite, no kit) ──────────────────────────────────────────────
    if ("svelte" in deps) {
      return {
        type: "svelte",
        label: "Svelte",
        searchGlobs: jsGlobs,
        entryFiles: firstExisting(cwd, ["index.html", "public/index.html"]),
        placement: "index.html (before </head>)",
      };
    }

    // ── React SPA (CRA or Vite) ────────────────────────────────────────────────
    if ("react" in deps) {
      return {
        type: "react",
        label:
          "react-scripts" in deps ? "React (CRA)" : "React (Vite)",
        searchGlobs: jsGlobs,
        entryFiles: firstExisting(cwd, [
          "public/index.html",
          "index.html",
        ]),
        placement: "index.html (before </body>)",
      };
    }
  }

  // ── WordPress / PHP theme ────────────────────────────────────────────────────
  const wpHeader = findWordpressHeader(cwd);
  if (
    wpHeader.length ||
    has(cwd, "wp-config.php") ||
    has(cwd, "wp-content") ||
    has(cwd, "style.css") && has(cwd, "functions.php")
  ) {
    return {
      type: "wordpress",
      label: "WordPress",
      searchGlobs: ["**/*.php", "**/*.html"],
      entryFiles: wpHeader,
      placement: "Theme header.php (before wp_head/</head>)",
    };
  }

  // ── Plain static HTML ────────────────────────────────────────────────────────
  const htmlEntry = firstExisting(cwd, [
    "index.html",
    "public/index.html",
    "src/index.html",
  ]);
  if (htmlEntry.length) {
    return {
      type: "html",
      label: "HTML",
      searchGlobs: ["**/*.html"],
      entryFiles: htmlEntry,
      placement: "index.html (before </body>)",
    };
  }

  return {
    type: "unknown",
    label: "Unknown",
    searchGlobs: ["**/*.{html,tsx,ts,jsx,js,vue,svelte,astro,php}"],
    entryFiles: [],
    placement: "Manual — no entry point detected",
  };
}

/**
 * Quick check used by the bulk scanner to decide whether a directory is a
 * project worth processing at all.
 */
export function looksLikeProject(dir: string): boolean {
  return (
    has(dir, "package.json") ||
    has(dir, "index.html") ||
    has(dir, "public/index.html") ||
    has(dir, "src/index.html") ||
    has(dir, "wp-config.php") ||
    has(dir, "style.css") ||
    has(dir, "composer.json") ||
    findWordpressHeader(dir).length > 0
  );
}
