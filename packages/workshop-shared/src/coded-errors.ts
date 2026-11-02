// Internal to this package: not listed in package.json "exports", so only api.ts and
// gatekeeper.ts import it.

/** Builds the create/read helpers for a family of expected errors carrying stable
 * machine-readable codes. The per-code messages double as the classification fallback for errors
 * from older deployments that lost the code in transit, so changing one is a compatibility break. */
export function codedErrorFamily<Code extends string>(messages: Record<Code, string>) {
  const codes = new Set<unknown>(Object.keys(messages));
  return {
    create: (code: Code): Error & { code: Code } =>
        Object.assign(new Error(messages[code]), { code }),
    getCode: (error: unknown): Code | undefined => {
      const candidate = typeof error === "object" && error !== null && "code" in error
          ? error.code : undefined;
      return codes.has(candidate) ? candidate as Code : undefined;
    },
  };
}
