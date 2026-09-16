// Small helpers with no policy in them. Kept apart from `tools.ts` so that file stays only the trust
// boundary.

/** Lowercase hex for a byte string. Used for nonces and catalog fingerprints. */
export function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Upper-snake-cases an id for use in a suggested binding name (e.g. `my-portal` -> `MY_PORTAL`). */
export function bindingNameFragment(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

// Longest run of server-written text quoted back inside an error message.
const MAX_QUOTED_TEXT = 200;

// Shortest value worth removing. Below this a "secret" is more likely to be a word that occurs in
// ordinary prose, where blanking it destroys the explanation instead of protecting anything.
const MIN_REDACTABLE_SECRET = 8;

// Every spelling a secret can come back in.
//
// The value as sent is not the only form to look for: a far side quoting the offending *request*
// echoes an encoded body, and a base64 credential is mostly `+`, `/` and `=`, none of which survive
// as themselves. Matching only the literal value walks straight past it.
function secretSpellings(secret: string): string[] {
  const formEncoded = new URLSearchParams({ v: secret }).toString().slice(2);
  return [...new Set([secret, encodeURIComponent(secret), formEncoded])];
}

/**
 * Removes every known secret from text written by the far side.
 *
 * One implementation on purpose. This used to be written out separately at each place a credential
 * could be echoed back, and the copies drifted: one was fixed to redact before capping while the
 * other still capped first, so the same bug survived in the site nobody re-read. Callers pass what
 * they sent; this decides how thoroughly to look for it.
 *
 * Always run this *before* `safeServerText`. Capping first can slice a secret across the boundary,
 * and the surviving head no longer matches anything to redact -- leaving a usable prefix in text
 * that looks sanitized.
 */
export function redactSecrets(
  text: string, secrets: readonly (string | null | undefined)[],
): string {
  const spellings: string[] = [];
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_REDACTABLE_SECRET) continue;
    spellings.push(...secretSpellings(secret));
  }

  // Longest first, so one spelling that contains another cannot be left half-replaced.
  let scrubbed = text;
  for (const spelling of spellings.toSorted((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(spelling).join("[redacted]");
  }
  return scrubbed;
}

/**
 * Prepares text written by a remote server for inclusion in an error message.
 *
 * Error messages here are logged and dispatched to the issue reporter, so text from the far side is
 * capped and flattened before it is quoted: an unbounded string pushes real context out of a
 * report, and an embedded newline lets a server forge a second entry inside a log line. Returns
 * undefined when nothing usable survives, so callers fall back to their own wording rather than
 * quoting an empty string.
 */
export function safeServerText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters go entirely; the rest collapses to single spaces.
  // oxlint-disable-next-line no-control-regex -- intentionally stripping control chars (log-forging guard)
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_QUOTED_TEXT
    ? `${cleaned.slice(0, MAX_QUOTED_TEXT)}\u2026`
    : cleaned;
}

/** The host of an endpoint URL, for log fields and human-facing messages. */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}
