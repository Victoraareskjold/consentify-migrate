# consentify-migrate

[![npm version](https://img.shields.io/npm/v/consentify-migrate.svg)](https://www.npmjs.com/package/consentify-migrate)
[![npm downloads](https://img.shields.io/npm/dm/consentify-migrate.svg)](https://www.npmjs.com/package/consentify-migrate)
[![license](https://img.shields.io/npm/l/consentify-migrate.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/consentify-migrate.svg)](https://nodejs.org)

**Replace your cookie banner across one site, or forty, in a single command.**

Switching consent platforms means touching every file that loads a tracker, on every site you own. This does it for you: it detects your framework, removes the CMP you have today, strips every tracking script so nothing fires before consent, scans your live site to catch what static analysis misses, sets those tools back up behind a consent gate, injects the new script where it actually belongs, and commits.

```bash
# Single project, run from the project root
npx consentify-migrate

# Skip the domain prompt
npx consentify-migrate example.com

# A whole folder of client sites
npx consentify-migrate bulk ./clients
```

No installation needed.

---

## Try it without touching anything

This tool deletes code and commits to git, so start here:

```bash
npx consentify-migrate --dry-run
```

Dry run detects and reports everything it *would* do. No API calls, no file writes, no git. Run it first.

---

## What it actually does

1. **Detects your framework** and the exact entry point for it.
2. **Finds and removes your existing consent tool.** Recognizes Cookiebot, OneTrust, CookieYes, CookieFirst, Termly, Osano, Iubenda, Usercentrics, Didomi, TrustArc, Civic, Cookie Script, Klaro, Complianz, Borlabs, Quantcast, Sourcepoint, and vanilla Cookie Consent. If the site has no CMP yet, it sets Consentify up fresh.
3. **Detects your integrations** by running a live GDPR scan against your domain, which catches tools loaded through GTM that source-code scanning misses. Falls back to source analysis if the site isn't reachable. Every analytics and marketing tracker in your code is stripped so nothing fires before consent, then re-registered behind the consent gate. Payment and embed scripts (Stripe, PayPal, Klarna, reCAPTCHA, YouTube, Calendly) are left untouched.
4. **Finds your privacy policy** by looking for a policy route in the project (`privacy`, `privacy-policy`, `personvern`, `cookies`, and more, across languages).
5. **Logs you in.** Credentials are used once and never stored.
6. **Creates your domain** and configures the detected integrations.
7. **Injects the script** at the correct location for your framework.
8. **Commits the change** on a dedicated branch.

Re-running is safe. If Consentify is already present in a project, it's skipped.

---

## Bulk mode

Point it at a folder whose immediate subfolders are individual sites:

```bash
npx consentify-migrate bulk ./clients
```

```
clients/
  acme.com/            → Next.js (App Router)
  bergen-cafe/         → WordPress
  nordic-shop.no/      → Vue
  ...
```

Every project gets the full treatment above, each on its own branch. **A failure on one project never stops the rest of the batch.** At the end you get a `consentify-migration-report.md` (and `.json`) listing every domain, token, and anything that needs manual follow-up.

Before starting, the run checks your plan's domain capacity. If the folder has more sites than you have room for, it tells you up front and sets up as many as fit rather than failing partway through.

### Resolving domains

Each site needs a domain. Resolved in this order:

1. **Manifest file** (recommended for large batches), matched by folder name
2. **Folder name**, if it's itself a domain (e.g. `acme.com`)
3. **Git remote**, if the repo name is a domain
4. **Prompt**, for anything still unresolved (unless `--yes`)

Manifest as CSV:

```csv
folder,domain,policyUrl
acme-site,acme.com,https://acme.com/privacy
bergen-cafe,bergen-cafe.no,
```

or JSON:

```json
{ "acme-site": "acme.com", "bergen-cafe": "bergen-cafe.no" }
```

```bash
npx consentify-migrate bulk ./clients --manifest ./domains.csv --yes
```

---

## Git modes

By default every project is committed on a dedicated `consentify-setup` branch and pushed, so nothing lands on `main` without review. Only the files the tool changed are staged, so any pre-existing uncommitted work is left alone.

| Flag           | Behavior                                                  |
| -------------- | --------------------------------------------------------- |
| `--git=branch` | Create `consentify-setup` branch, commit, push (default). |
| `--git=push`   | Commit on the current branch and push.                    |
| `--git=commit` | Commit only, no push.                                     |
| `--git=none`   | File changes only, no git.                                |

---

## Options

| Flag                     | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `bulk [dir]` / `--all`   | Bulk mode over a folder of projects (default dir: cwd).              |
| `--manifest <file>`      | CSV or JSON folder to domain mapping.                                |
| `--policy-pattern "<p>"` | Fallback privacy policy URL if none detected, `{domain}` substituted. |
| `--git=<mode>`           | Git behavior (see above).                                            |
| `--no-scan`              | Skip the live scanner; detect integrations from source only.          |
| `--dry-run`              | Detect and report only. No API calls, file writes, or git.            |
| `--yes` / `-y`           | Skip confirmation prompts (requires resolvable domains).              |

Non-interactive agency run:

```bash
npx consentify-migrate bulk ./clients \
  --manifest ./domains.csv \
  --policy-pattern "https://{domain}/personvern" \
  --git=branch --yes
```

---

## Supported frameworks

The script goes where it actually belongs, not just anywhere.

| Framework              | Where the script goes             |
| ---------------------- | --------------------------------- |
| Next.js (App Router)   | Root layout `<body>` via `next/script` |
| Next.js (Pages Router) | `pages/_document` (created if missing) |
| React (CRA / Vite)     | `index.html` before `</body>`     |
| Vue                    | `index.html` before `</head>`     |
| Nuxt                   | Generated client plugin using `useHead` |
| SvelteKit              | `src/app.html`                    |
| Svelte (Vite)          | `index.html`                      |
| Astro                  | Base layout `<head>`              |
| Angular                | `src/index.html`                  |
| WordPress              | Theme `header.php` before `wp_head()` |
| Vanilla HTML           | `index.html` before `</body>`     |

**Your framework missing, or detection got it wrong?** [Open an issue](https://github.com/consentify/consentify-migrate/issues/new?template=detection.yml). That's the single most useful thing you can contribute.

---

## Supported integrations

Google Analytics, Google Tag Manager, Google Ads, Facebook Pixel, PostHog, TikTok Pixel, LinkedIn Insight Tag, Snapchat Pixel, HubSpot, Contentsquare, Intercom.

Integrations that are detected but whose ID couldn't be extracted are flagged in the report so you can configure them manually. Trackers with no built-in integration (X, Reddit, Clarity, Hotjar, Segment) are reported so you can re-add them as custom integrations.

---

## Requirements

- Node.js 18 or later
- Git (for commit and push modes)
- A [Consentify account](https://consentify.app). The free tier covers most single sites. Bulk runs need enough domain capacity on your plan.

---

## Development

```bash
npm install
npm run dev -- --dry-run   # run from source
npm run typecheck
npm run build              # bundles to dist/index.cjs
```

The CLI talks to the Consentify API using the public publishable Supabase key, which is embedded on purpose. Access is enforced by row level security, not by hiding the key.

---

## Contributing

The most valuable contributions are detection fixes. If the tool misidentified your framework, missed a CMP, or put the script in the wrong place, open an issue with your project structure and it'll usually be a small fix.

1. Fork and branch off `main`
2. `npm install`
3. Make the change, run `npm run typecheck`
4. Test against a real project with `--dry-run`
5. Open a PR describing the setup you were testing against

---

## License

MIT. See [LICENSE](./LICENSE).
