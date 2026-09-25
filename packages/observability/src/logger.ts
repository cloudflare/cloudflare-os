import { createLoggerWithContext } from "./logger-core.js";

export type { Logger, LogValue } from "./logger-core.js";

/** Creates an ALS-free structured Worker logger with fixed component metadata. */
export function createLogger<ExtraFields extends object = Record<never, never>>(
  defaults: Parameters<typeof createLoggerWithContext<ExtraFields>>[0],
) {
  return createLoggerWithContext<ExtraFields>(defaults);
}
