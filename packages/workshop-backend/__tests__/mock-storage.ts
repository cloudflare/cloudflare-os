// oxlint-disable-next-line typescript/triple-slash-reference -- Wrangler declarations are globals.
/// <reference path="../worker-configuration.d.ts" />

// Map-backed mock DurableObjectStorage for unit tests, mirroring
// packages/typed-storage/__tests__/index.test.ts. structuredClone on every read/write mimics the
// serialization boundary of real DO storage, and the iterator-invalidation check mirrors the real
// kv.list() contract.
export function makeMockStorage(): DurableObjectStorage {
  let map = new Map<string, any>();
  let currentList: object | undefined;

  return <DurableObjectStorage>{
    transactionSync<T>(f: () => T): T {
      let oldMap = structuredClone(map);
      try {
        return f();
      } catch (err) {
        map = oldMap;
        throw err;
      }
    },
    kv: {
      get<T>(key: string): T | undefined {
        return structuredClone(map.get(key));
      },
      *list<T = unknown>(options: DurableObjectListOptions = {}): Iterable<[string, T]> {
        let results: { key: string; value: any }[] = [];
        for (let [key, value] of map) {
          if ((options.prefix === undefined || key.startsWith(options.prefix))
              && (options.start === undefined || key >= options.start)
              && (options.startAfter === undefined || key > options.startAfter)
              && (options.end === undefined || key < options.end)) {
            results.push({ key, value });
          }
        }
        results.sort((a, b) => {
          if (a.key < b.key) return options.reverse ? 1 : -1;
          if (a.key > b.key) return options.reverse ? -1 : 1;
          return 0;
        });
        if (options.limit !== undefined) {
          results = results.slice(0, options.limit);
        }
        let me = {};
        currentList = me;
        for (let item of results) {
          yield [item.key, structuredClone(item.value)];
          if (currentList !== me) {
            throw new Error("kv.list() iterator was invalidated by a concurrent kv.list().");
          }
        }
        currentList = undefined;
      },
      put<T>(key: string, value: T): void {
        map.set(key, structuredClone(value));
      },
      delete(key: string): boolean {
        return map.delete(key);
      },
    },
  };
}
