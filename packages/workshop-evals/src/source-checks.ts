/**
 * Web APIs that do not work inside a Gadget, and what happens when code calls one.
 *
 * A Gadget's UI runs in an opaque-origin sandboxed iframe under a strict Content Security Policy,
 * and its server runs with no outbound network. Code that reaches for one of these still parses and
 * still loads, so nothing else in the suite notices: the feature built on it is simply dead. An agent
 * wrapping the call in `try`/`catch` makes it quieter still.
 *
 * Each pattern needs an unambiguous match. A bare `alert(` or `fetch(` could name a method the Gadget
 * itself defined, so this list takes the qualified forms only and accepts that it will miss some real
 * cases. It reports, and never decides a verdict, so a miss costs less than a false accusation.
 */
const UNAVAILABLE_APIS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /\blocalStorage\b/, reason: "throws: the UI frame has an opaque origin" },
  { pattern: /\bsessionStorage\b/, reason: "throws: the UI frame has an opaque origin" },
  { pattern: /\bXMLHttpRequest\b/, reason: "blocked by the frame's connect-src policy" },
  { pattern: /\bEventSource\b/, reason: "blocked by the frame's connect-src policy" },
  { pattern: /\bnew\s+WebSocket\s*\(/, reason: "blocked by the frame's connect-src policy" },
  { pattern: /\bwindow\.open\s*\(/, reason: "the host replaces it with a no-op" },
  { pattern: /\bwindow\.print\s*\(/, reason: "PDF export belongs to the platform, not the Gadget" },
  { pattern: /\bwindow\.(?:alert|confirm|prompt)\s*\(/, reason: "the frame sandbox blocks modals" },
];

/** One use of an API that does not work inside a Gadget. */
export type SandboxViolation = {
  /** File the use appears in. */
  file: string;
  /** The API named, as it appeared. */
  api: string;
  /** Why it does not work. */
  reason: string;
};

/**
 * Reports uses of APIs that a Gadget cannot use, across one Gadget's source.
 *
 * The suite already covers syntax: every `.js` file becomes a module in the Gadget's Worker, so a
 * file that cannot parse stops the server from starting and fails every check. This covers the next
 * layer — code that loads and runs, and then does nothing.
 */
export function findSandboxViolations(files: ReadonlyMap<string, string>): SandboxViolation[] {
  const violations: SandboxViolation[] = [];
  for (const [file, contents] of files) {
    if (!file.endsWith(".js")) continue;
    for (const { pattern, reason } of UNAVAILABLE_APIS) {
      const match = pattern.exec(contents);
      if (match !== null) violations.push({ file, api: match[0], reason });
    }
  }
  return violations;
}
