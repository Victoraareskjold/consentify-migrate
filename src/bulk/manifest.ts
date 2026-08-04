import { readFileSync } from "fs";
import { basename } from "path";

export interface ManifestEntry {
  domain: string;
  policyUrl?: string;
}

/** folder name (basename) → mapping */
export type Manifest = Map<string, ManifestEntry>;

/**
 * Load a folder→domain manifest. Supports:
 *  - CSV:  `folder,domain,policyUrl` (header optional)
 *  - JSON: { "folder": "domain" }  or
 *          [ { "folder": "...", "domain": "...", "policyUrl": "..." } ]
 * Folder keys are matched against each project directory's basename.
 */
export function loadManifest(path: string): Manifest {
  const raw = readFileSync(path, "utf-8");
  const map: Manifest = new Map();

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const json = JSON.parse(trimmed) as unknown;
    if (Array.isArray(json)) {
      for (const row of json as Array<Record<string, string>>) {
        const folder = row.folder ?? row.dir ?? row.name;
        if (folder && row.domain) {
          map.set(basename(folder), {
            domain: row.domain,
            policyUrl: row.policyUrl,
          });
        }
      }
    } else {
      for (const [folder, domain] of Object.entries(
        json as Record<string, string>,
      )) {
        map.set(basename(folder), { domain });
      }
    }
    return map;
  }

  // CSV
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(",").map((c) => c.trim());
    // Skip a header row.
    if (/^(folder|dir|name)$/i.test(cols[0]) && /^domain$/i.test(cols[1] ?? "")) {
      continue;
    }
    const [folder, domain, policyUrl] = cols;
    if (folder && domain) {
      map.set(basename(folder), { domain, policyUrl: policyUrl || undefined });
    }
  }
  return map;
}
