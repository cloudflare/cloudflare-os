/**
 * Builds helpers for expected errors whose `code` property is the sole classification signal.
 * Unknown or missing codes are left unclassified, regardless of message text or constructor.
 */
export function codedErrorFamily<Code extends string>(messages: Record<Code, string>) {
  return {
    create: (code: Code): Error & { code: Code } =>
        Object.assign(new Error(messages[code]), { code }),
    getCode: (error: unknown): Code | undefined => {
      const candidate = typeof error === "object" && error !== null && "code" in error
          ? error.code : undefined;
      return typeof candidate === "string" && Object.hasOwn(messages, candidate)
          ? candidate as Code : undefined;
    },
  };
}
