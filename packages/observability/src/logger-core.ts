/** A value that Workers Logs can represent as structured log data. */
export type LogValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | { [key: string]: LogValue }
  | LogValue[];

type LogLevel = "debug" | "info" | "warn" | "error";
export type ReservedLogField =
  | "body"
  | "component"
  | "error"
  | "errorStack"
  | "event"
  | "header"
  | "headers"
  | "message"
  | "prompt"
  | "secret"
  | "token";
type SafeFields<ExtraFields extends object> = {
  [Key in keyof ExtraFields as Key extends ReservedLogField ? never : Key]:
    ExtraFields[Key] extends LogValue ? ExtraFields[Key] : never;
};
type ProhibitedFields<
  ExtraFields extends object,
  Exceptions extends ReservedLogField = never,
> = { [Key in Extract<keyof ExtraFields, Exclude<ReservedLogField, Exceptions>>]?: never };
type AllowedFields<ExtraFields extends object> =
  SafeFields<ExtraFields> & ProhibitedFields<ExtraFields>;
type LogDetails<ExtraFields extends object> =
  Partial<SafeFields<ExtraFields>> & ProhibitedFields<ExtraFields, "event" | "error"> & {
  event: string;
  error?: unknown;
};
type LoggerDefaults<ExtraFields extends object> =
  Partial<SafeFields<ExtraFields>> & ProhibitedFields<ExtraFields, "component"> & {
  component: string;
};
type LogContextReader = () => Readonly<Record<string, LogValue>> | undefined;

function normalizeError(error: unknown): string {
  if (error instanceof Error) return String(error);
  if (typeof error === "object" && error !== null) {
    const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** A structured logger with immutable base fields and optional package-local fields. */
export interface Logger<ExtraFields extends object = Record<never, never>> {
  /** Returns a new logger with additional fields without changing this logger. */
  with(fields: Readonly<Partial<AllowedFields<ExtraFields>>>): Logger<ExtraFields>;
  /** Emits a noisy diagnostic event. */
  debug(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
  /** Emits a notable lifecycle event. */
  info(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
  /** Emits a failure from which the operation can continue. */
  warn(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
  /** Emits a failure that needs attention. */
  error(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
}

class LoggerImpl<ExtraFields extends object> implements Logger<ExtraFields> {
  readonly #defaults: Readonly<LoggerDefaults<ExtraFields>>;
  readonly #readContext: LogContextReader;

  constructor(defaults: Readonly<LoggerDefaults<ExtraFields>>, readContext: LogContextReader) {
    this.#defaults = { ...defaults };
    this.#readContext = readContext;
  }

  with(fields: Readonly<Partial<AllowedFields<ExtraFields>>>): Logger<ExtraFields> {
    const defaults = { ...this.#defaults, ...fields } as LoggerDefaults<ExtraFields>;
    return new LoggerImpl<ExtraFields>(defaults, this.#readContext);
  }

  debug(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
    this.#write("debug", message, details);
  }

  info(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
    this.#write("info", message, details);
  }

  warn(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
    this.#write("warn", message, details);
  }

  error(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
    this.#write("error", message, details);
  }

  #write(level: LogLevel, message: string, details: Readonly<LogDetails<ExtraFields>>): void {
    // Explicit logger fields override ambient context; call details override both; component is fixed.
    const { component } = this.#defaults;
    const fields: Record<string, unknown> = {
      ...this.#readContext(),
      ...this.#defaults,
      ...details,
      component,
    };
    if (details.error === undefined) {
      delete fields.error;
    } else {
      const error: unknown = details.error;
      fields.error = normalizeError(error);
      if (error instanceof Error && error.stack) fields.errorStack = error.stack;
    }
    console[level]({ ...fields, message });
  }
}

/** Creates a structured logger using an optional ambient-context reader. */
export function createLoggerWithContext<ExtraFields extends object = Record<never, never>>(
  defaults: Readonly<LoggerDefaults<NoInfer<ExtraFields>>>,
  readContext: LogContextReader = () => undefined,
): Logger<ExtraFields> {
  return new LoggerImpl(defaults, readContext);
}
