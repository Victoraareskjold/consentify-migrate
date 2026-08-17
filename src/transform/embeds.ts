/**
 * Rewrites third-party embeds so they are held back until consent.
 *
 * A `<iframe src="...youtube.com/embed/...">` written straight into the markup
 * cannot be blocked from JavaScript. The browser starts the request the moment
 * it parses the tag, before any script on the page has run, so a consent tool
 * can hide the embed and disclose it but not prevent it. Moving the address
 * into `data-csfy-src` leaves the browser with nothing to fetch, and the
 * Consentify banner puts `src` back once the visitor agrees.
 *
 * Loader scripts (Calendly, Typeform, Instagram, X) need the same treatment
 * plus `type="text/plain"`, because a `<script src>` is fetched and executed
 * during parsing exactly like an iframe. The browser will not run a type it
 * does not recognise, so the two together make it inert.
 *
 * PATTERNS below mirror lib/embeds/index.ts in the app. As with trackers.ts we
 * keep a local copy rather than importing it: that module is part of a Next.js
 * app and pulling it into this standalone CLI breaks the type-check and publish
 * boundary. When an embed is added or its pattern changes there, update it here.
 */

import { readFileSync, writeFileSync } from "fs";
import type { TransformResult } from "./index.js";

interface EmbedPattern {
  id: string;
  name: string;
  /** Matched against an <iframe src>. */
  frame?: RegExp;
  /** Matched against a <script src>. */
  script?: RegExp;
}

const PATTERNS: EmbedPattern[] = [
  { id: "youtube_embed", name: "YouTube", frame: /(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//i },
  { id: "vimeo_embed", name: "Vimeo", frame: /player\.vimeo\.com\/video\//i },
  { id: "google_maps", name: "Google Maps", frame: /(?:www\.)?google\.[a-z.]+\/maps\/embed/i },
  { id: "spotify", name: "Spotify", frame: /open\.spotify\.com\/embed/i },
  { id: "soundcloud", name: "SoundCloud", frame: /w\.soundcloud\.com\/player/i },
  { id: "facebook_connect", name: "Facebook", frame: /(?:www\.)?facebook\.com\/plugins\//i },
  {
    id: "calendly",
    name: "Calendly",
    frame: /(?:www\.)?calendly\.com\//i,
    script: /assets\.calendly\.com\/assets\/external\/widget\.js/i,
  },
  {
    id: "instagram_embed",
    name: "Instagram",
    frame: /(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[^/]+\/embed/i,
    script: /(?:www\.)?instagram\.com\/embed\.js/i,
  },
  {
    id: "twitter_widgets",
    name: "X (Twitter)",
    frame: /platform\.twitter\.com\/embed|platform\.x\.com\/embed/i,
    script: /platform\.(?:twitter|x)\.com\/widgets\.js/i,
  },
  {
    id: "typeform",
    name: "Typeform",
    frame: /(?:form|embed)\.typeform\.com\//i,
    script: /embed\.typeform\.com\/next\/embed\.js/i,
  },
];

/** `src="..."`, `src='...'` and JSX `src={"..."}`, capturing the URL. */
const SRC_ATTR = /\ssrc\s*=\s*(?:\{?\s*)?(["'])(.*?)\1/i;

function alreadyRewritten(tag: string): boolean {
  return /data-csfy-src\s*=/i.test(tag);
}

/**
 * Rewrite every recognised embed in one file. Tags are matched whole so the
 * replacement can be applied to the exact opening tag, which keeps JSX props,
 * Liquid output and Blade directives around it untouched.
 */
export function rewriteEmbedsInFile(filePath: string): TransformResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { file: filePath, changed: false, description: "Could not read file" };
  }

  const found: string[] = [];

  const rewriteTags = (re: RegExp, kind: "frame" | "script") => {
    content = content.replace(re, (tag) => {
      if (alreadyRewritten(tag)) return tag;
      const m = tag.match(SRC_ATTR);
      if (!m) return tag;
      const url = m[2];
      const def = PATTERNS.find((p) => {
        const pattern = kind === "frame" ? p.frame : p.script;
        return pattern && pattern.test(url);
      });
      if (!def) return tag;

      found.push(def.name);
      let out = tag.replace(SRC_ATTR, (attr) => attr.replace(/\ssrc\s*=/i, " data-csfy-src="));

      if (kind === "script") {
        // Replace an existing type rather than adding a second one, or the
        // browser reads the first and runs the script anyway.
        out = /\stype\s*=/i.test(out)
          ? out.replace(/\stype\s*=\s*(["']).*?\1/i, ' type="text/plain"')
          : out.replace(/^<script/i, '<script type="text/plain"');
      }
      return out;
    });
  };

  rewriteTags(/<iframe\b[^>]*>/gi, "frame");
  rewriteTags(/<script\b[^>]*>/gi, "script");

  if (!found.length) {
    return { file: filePath, changed: false, description: "No embeds to rewrite" };
  }

  writeFileSync(filePath, content, "utf-8");
  const unique = [...new Set(found)];
  return {
    file: filePath,
    changed: true,
    description: `Gated ${unique.length === 1 ? "embed" : "embeds"}: ${unique.join(", ")}`,
    rewrittenEmbeds: unique,
  };
}
