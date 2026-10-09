import { createLogger } from "../src/logger.js";
import { createObservabilityContext } from "../src/observability-context.js";

const obsContext = createObservabilityContext<{
  chatId: number;
  operation: string;
}>();
const sensitiveObsContext = createObservabilityContext<{ token: string }>();
// @ts-expect-error context vocabularies contain only structured log values
createObservabilityContext<{ invalid: Uint8Array }>();

let logger = createLogger<{
  accountId?: number;
  chatId?: number;
  durationMs?: number;
  providerRequestId?: string;
}>({ component: "test" });
let loggerWithoutPackageFields = createLogger({ component: "test" });
let loggerWithSensitivePackageFields = createLogger<{
  body?: string;
  header?: string;
  headers?: string;
  prompt?: string;
  secret?: string;
  token?: string;
}>({ component: "test" });
// @ts-expect-error sensitive fields cannot be logger defaults even when declared
createLogger<{ token?: string }>({ component: "test", token: "private token" });
logger.info("valid", { event: "valid", accountId: 1, providerRequestId: "request-1" });
logger.with({ chatId: 1 });
logger.with({ providerRequestId: "request-2" });
// @ts-expect-error ambient context is read from its observability context, not from a logger
logger.getContext();
obsContext.with({ operation: "test.operation" }, () => {});
const currentContext: Readonly<Partial<{ chatId: number; operation: string }>> = obsContext.get();
const currentChatId: number | undefined = currentContext.chatId;
void currentContext;
void currentChatId;
// @ts-expect-error context values retain their declared types
const invalidChatId: string | undefined = obsContext.get().chatId;
void invalidChatId;
// @ts-expect-error context fields must use their declared types
obsContext.with({ chatId: "one" }, () => {});
// @ts-expect-error context fields must be declared in the package vocabulary
obsContext.with({ gadgetId: "gadget-1" }, () => {});
// @ts-expect-error sensitive fields are not accepted in ambient context
obsContext.with({ token: "private token" }, () => {});
// @ts-expect-error sensitive fields remain prohibited when declared in the context vocabulary
sensitiveObsContext.with({ token: "private token" }, () => {});
// @ts-expect-error errors belong to individual log entries, not ambient context
obsContext.with({ error: "boom" }, () => {});
// @ts-expect-error error stacks are produced by the logger, not ambient context
obsContext.with({ errorStack: "stack" }, () => {});
// @ts-expect-error components are fixed when a logger is created
obsContext.with({ component: "other" }, () => {});
// @ts-expect-error events belong to individual log entries, not ambient context
obsContext.with({ event: "other" }, () => {});
// @ts-expect-error messages are the first argument to a log method
obsContext.with({ message: "other" }, () => {});

// @ts-expect-error event is required
logger.info("missing event", { accountId: 1 });
// @ts-expect-error misspelled package field
logger.info("misspelled", { event: "invalid", acountId: 1 });
// @ts-expect-error invalid shared field type
logger.info("wrong type", { event: "invalid", durationMs: "slow" });
// @ts-expect-error sensitive fields are not accepted
logger.info("sensitive", { event: "invalid", body: "secret" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.info("sensitive", { event: "invalid", body: "secret" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ header: "authorization" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ headers: "authorization" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ prompt: "private prompt" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ secret: "private secret" });
// @ts-expect-error sensitive fields remain prohibited when declared in the package vocabulary
loggerWithSensitivePackageFields.with({ token: "private token" });
// @ts-expect-error misspelled package-local field
logger.with({ providerRequstId: "request-3" });
// @ts-expect-error errors belong to individual log entries, not inherited logger context
logger.with({ error: new Error("boom") });
// @ts-expect-error package fields must be declared on this logger
loggerWithoutPackageFields.info("undeclared", { event: "invalid", accountId: 1 });
