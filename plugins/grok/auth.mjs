import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// dscode: the Grok subscription rail authenticates with the OAuth credentials the
// official `grok` CLI stores after `grok login`. DSCODE reads that file and never writes
// it: the CLI owns token rotation, and a refresh token rotated by a second writer would
// log the CLI out (the same trap the Hub token rotation sets). An expired token is
// reported with the command that fixes it, never silently refreshed.

/** The file the grok CLI writes: one entry per issuer/client, keyed `https://auth.x.ai::<client id>`. */
export const GROK_AUTH_PATH = join(homedir(), ".grok", "auth.json");
/** Credential ref the `/provider` machinery reads; resolved read-only from the CLI file. */
export const GROK_TOKEN_REF = "GROK_CLI_TOKEN";

/** Decode a JWT payload without verifying: only `exp`/`sub` are read, and xAI validates the token. */
function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * One CLI credential from a parsed auth file: the first issuer entry, whose access token
 * is `key`. Unknown shapes answer undefined instead of throwing.
 * @returns `{ token, refreshToken?, userId?, expiresAt?, issuer?, clientId? }`, or undefined.
 */
export function parseGrokAuth(value) {
  if (value === null || typeof value !== "object") return undefined;
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.key !== "string" || entry.key.length === 0) continue;
    const claims = jwtClaims(entry.key);
    const expiresAt = Number.isFinite(claims?.exp) ? claims.exp * 1000 : Date.parse(entry.expires_at ?? "");
    return {
      token: entry.key,
      ...typeof entry.refresh_token === "string" && entry.refresh_token.length > 0 ? { refreshToken: entry.refresh_token } : {},
      ...typeof entry.user_id === "string" && entry.user_id.length > 0 ? { userId: entry.user_id } : typeof claims?.sub === "string" ? { userId: claims.sub } : {},
      ...Number.isFinite(expiresAt) ? { expiresAt } : {},
      ...name.includes("::") ? { issuer: name.split("::")[0], clientId: name.split("::")[1] } : {},
    };
  }
  return undefined;
}

/**
 * The local Grok login as one fact set, with no I/O of its own beyond the injected read.
 * @returns `{ kind: "ready"|"expired"|"missing"|"malformed", credential? }`; a missing file
 *   means the user never ran `grok login`, a malformed one means the CLI changed its shape.
 */
export function grokAuthState({ now = Date.now(), read = () => readFileSync(GROK_AUTH_PATH, "utf8") } = {}) {
  let raw;
  try {
    raw = read();
  } catch {
    return { kind: "missing" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  const credential = parseGrokAuth(parsed);
  if (credential === undefined) return { kind: "malformed" };
  if (credential.expiresAt !== undefined && credential.expiresAt <= now) return { kind: "expired", credential };
  return { kind: "ready", credential };
}

/** Minutes until the access token expires, or undefined when the file carries no expiry. */
export function minutesLeft(credential, now = Date.now()) {
  if (credential?.expiresAt === undefined) return undefined;
  return Math.max(0, Math.round((credential.expiresAt - now) / 60000));
}
