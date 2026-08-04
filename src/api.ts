import { createClient } from "@supabase/supabase-js";

// Public Supabase credentials — safe to embed (NEXT_PUBLIC_* values)
const SUPABASE_URL = "https://dmfoyyndfpxllkbfqmio.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtZm95eW5kZnB4bGxrYmZxbWlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgzOTQ5MDYsImV4cCI6MjA3Mzk3MDkwNn0._gMAbCHGc6kikJcQPUvLKynDLhHQSuaTud7bopDluN8";
// Use the canonical host. The apex (consentify.app) 301-redirects to www, and
// browsers/Node strip the Authorization header across that origin change, which
// breaks token-authenticated calls (capacity, scan). Point straight at www.
// Override for local testing, e.g. CONSENTIFY_API_BASE=http://localhost:3000
const API_BASE = "https://www.consentify.app".replace(/\/$/, "");

export interface Team {
  id: string;
  name: string;
}

export interface SetupResult {
  publicToken: string;
  domainId: string;
  domain: string;
  integrationsSaved?: string[];
}

export interface DetectedTracker {
  id: string;
  name: string;
  category: string;
}

export interface ScanTracker {
  id: string;
  name: string;
  category: string;
  isCMP?: boolean;
  isActive?: boolean;
  networkCalls?: boolean;
}

export interface ScanResult {
  domain: string;
  trackers: ScanTracker[];
  detections: Record<string, { extractedId?: string }>;
}

export interface Capacity {
  domainCapacity: number | null; // null = unlimited
  used: number;
  remaining: number | null; // null = unlimited
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

let _accessToken: string | null = null;

export function getStoredAccessToken(): string | null {
  return _accessToken;
}

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<{ accessToken: string; userName: string }> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.session) {
    throw new Error(error?.message ?? "Login failed");
  }

  _accessToken = data.session.access_token;

  const userName =
    (data.user.user_metadata?.name as string) ||
    data.user.email?.split("@")[0] ||
    "there";

  return { accessToken: _accessToken, userName };
}

// ─── Teams ────────────────────────────────────────────────────────────────────

/**
 * Fetch teams directly from Supabase using the access token.
 * This avoids going through the Next.js API which only accepts cookie auth.
 */
export async function getTeams(accessToken: string): Promise<Team[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Get team memberships
  const { data: memberships, error: membError } = await supabase
    .from("team_users")
    .select("team_id")
    .eq("user_id", user.id);

  if (membError) throw new Error(membError.message);
  if (!memberships || memberships.length === 0) return [];

  const teamIds = memberships.map((m: { team_id: string }) => m.team_id);

  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id, name")
    .in("id", teamIds);

  if (teamsError) throw new Error(teamsError.message);

  return (teams ?? []) as Team[];
}

// ─── Browser-handoff auth ───────────────────────────────────────────────────────

export interface CliAuthStart {
  code: string;
  authUrl: string;
  pollUrl: string;
  expiresIn: number;
}

/**
 * Start a browser-handoff login. Returns the URL to open in the browser and the
 * URL to poll. The token is never returned here — only after the user finishes
 * login in the browser (see pollCliAuth).
 */
export async function startCliAuth(): Promise<CliAuthStart> {
  const res = await fetch(`${API_BASE}/api/cli/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Could not start login (${res.status})`);
  }
  return (await res.json()) as CliAuthStart;
}

/**
 * Poll until the browser login completes. Resolves with a real Supabase access
 * token and the user's team id. Rejects on expiry or timeout.
 */
export async function pollCliAuth(
  pollUrl: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ accessToken: string; teamId: string }> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(pollUrl);

    if (res.status === 410)
      throw new Error("Login expired — please try again.");

    if (res.ok) {
      const body = (await res.json()) as {
        status: string;
        accessToken?: string;
        teamId?: string;
      };
      if (body.status === "complete" && body.accessToken && body.teamId) {
        return { accessToken: body.accessToken, teamId: body.teamId };
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("Timed out waiting for login.");
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

/**
 * Scan a live domain via Consentify's GDPR scanner (the same one the dashboard
 * onboarding uses). Returns detected integrations (with extracted ids) and the
 * full tracker list. Requires the domain to be publicly reachable.
 */
export async function scanDomain(
  accessToken: string,
  domain: string,
): Promise<ScanResult> {
  const url = `${API_BASE}/api/scan?domain=${encodeURIComponent(domain)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Scan failed (${res.status})`);
  }
  return (await res.json()) as ScanResult;
}

export async function getCapacity(
  accessToken: string,
  teamId: string,
): Promise<Capacity> {
  const url = `${API_BASE}/api/cli/capacity?teamId=${encodeURIComponent(teamId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Capacity check failed (${res.status})`);
  }
  return (await res.json()) as Capacity;
}

export async function setupDomain(
  accessToken: string,
  payload: {
    teamId: string;
    domain: string;
    policyUrl?: string;
    integrations: Record<string, string>;
    detectedTrackers?: DetectedTracker[];
  },
): Promise<SetupResult> {
  const url = `${API_BASE}/api/cli/setup`;

  const requestHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  const requestBody = JSON.stringify(payload);

  let res: Response;
  try {
    // Use redirect: "manual" so we can re-POST to the redirect target.
    // Node fetch follows 301/302 by downgrading POST → GET (losing body + auth).
    res = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
      redirect: "manual",
    });

    // Follow a single redirect while keeping POST + headers
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        const redirectUrl = location.startsWith("http")
          ? location
          : new URL(location, url).toString();
        res = await fetch(redirectUrl, {
          method: "POST",
          headers: requestHeaders,
          body: requestBody,
        });
      }
    }
  } catch (err: unknown) {
    const cause =
      err instanceof Error && (err as Error & { cause?: unknown }).cause;
    const detail = cause
      ? String(cause)
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`Could not reach ${url}\n  ${detail}`);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server returned ${res.status} from ${url}`);
  }

  return (await res.json()) as SetupResult;
}
