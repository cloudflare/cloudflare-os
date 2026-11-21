import { env, runInDurableObject } from "cloudflare:test";
import { DocStore } from "../../src/docs-store";

/** Runs `run` inside a fresh `DocStoreHost`, over a `DocStore` on that object's storage. */
export function withDocStore<T>(
  run: (store: DocStore, storage: DurableObjectStorage) => T | Promise<T>,
): Promise<T> {
  const host = env.DOC_STORE_HOST.getByName(`store-${crypto.randomUUID()}`);
  return runInDurableObject(host, (_instance: unknown, state: DurableObjectState) =>
    run(new DocStore(state.storage), state.storage));
}
