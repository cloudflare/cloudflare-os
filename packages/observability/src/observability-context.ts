// oxlint-disable-next-line typescript/triple-slash-reference -- Makes the focused ALS type available to source consumers.
/// <reference path="./node-async-hooks.d.ts" />

import { AsyncLocalStorage } from "node:async_hooks";
import {
  createLoggerWithContext, type LogValue, type ReservedLogField,
} from "./logger-core.js";

export type { Logger, LogValue } from "./logger-core.js";

type ContextFields<Fields> = Partial<Fields> & { [Key in ReservedLogField]?: never };

/**
 * Creates an isolated, typed observability context for one package or domain.
 * Context does not cross RPC, hibernation, or restart; re-establish it at those boundaries.
 */
export function createObservabilityContext<
  Fields extends { [Key in keyof Fields]: LogValue },
>() {
  const storage = new AsyncLocalStorage<Readonly<ContextFields<Fields>>>();
  const empty = {} as Readonly<ContextFields<Fields>>;
  const get = () => storage.getStore() ?? empty;
  const createLogger = (defaults: Parameters<typeof createLoggerWithContext<Fields>>[0]) =>
    createLoggerWithContext<Fields>(defaults, get);
  const withContext = <Result>(
      fields: Readonly<ContextFields<Fields>>, callback: () => Result) =>
    storage.run({ ...get(), ...fields }, callback);

  return { createLogger, get, with: withContext };
}
