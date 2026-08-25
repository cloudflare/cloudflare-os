import { expect, it, describe } from "vitest"
import { createTypedStorage, collection, UniqueIndex, NonUniqueIndex } from "../src/index.js";
import { DurableObjectListOptions, DurableObjectStorage } from "@cloudflare/workers-types/experimental";

// We mock out DurableObjectStorage becaues otherwise we'd have to run the tests inside a
// Durable Object which is a bit of a trek.
function makeMockStorage(): DurableObjectStorage {
  // Storage is just backed by a Map.
  let map = new Map<string, any>();

  let currentList: object | undefined;

  return <DurableObjectStorage>{
    transactionSync<T>(f: () => T): T {
      // Implement transactions by cloning the entire database lol.
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
        let results: {key: string, value: any}[] = [];
        for (let [key, value] of map) {
          if (   (options.prefix     === undefined || key.startsWith(options.prefix))
              && (options.start      === undefined || key >= options.start)
              && (options.startAfter === undefined || key > options.startAfter)
              && (options.end        === undefined || key < options.end)) {
            results.push({key, value});
          }
        }

        results.sort((a, b) => {
          if (a.key < b.key) {
            return options.reverse ? 1 : -1;
          }
          if (a.key > b.key) {
            return options.reverse ? -1 : 1;
          }
          return 0;
        });

        if (options.limit !== undefined) {
          results = results.slice(0, options.limit);
        }

        let me = {};
        currentList = me;

        // To verify that the caller only iterates once, we don't simply return the array, but
        // rather generate the elements.
        for (let item of results) {
          yield [item.key, structuredClone(item.value)];

          // The real kv.list() only allows one outstanding cursor at a time, so emulate that here.
          if (currentList !== me) {
            throw new Error(
                "kv.list() iterator was invalidated because a new call to kv.list() was sarted. " +
                "Only one kv.list() iterator can exist at a time.");
          }
        }

        currentList = undefined;
      },
      put<T>(key: string, value: T): void {
        map.set(key, structuredClone(value));
      },
      delete(key: string): boolean {
        return map.delete(key);
      }
    }
  };
}

describe("singletons", () => {
  it("supports get and put", () => {
    let storage = createTypedStorage(makeMockStorage(), {
      singletons: {
        counter: 0,
        name: "Alice",
      }
    });

    expect(storage.counter.get()).toStrictEqual(0);
    expect(storage.name.get()).toStrictEqual("Alice");

    storage.counter.put(123);

    expect(storage.counter.get()).toStrictEqual(123);
    expect(storage.name.get()).toStrictEqual("Alice");

    storage.name.put("Bob");

    expect(storage.counter.get()).toStrictEqual(123);
    expect(storage.name.get()).toStrictEqual("Bob");
  });

  it("supports subscriptions", () => {
    let storage = createTypedStorage(makeMockStorage(), {
      singletons: {
        counter: 0,
        name: "Alice",
      }
    });

    let subscriber = {
      lastValue: -1,
      update(value: number) {
        this.lastValue = value;
      }
    };
    storage.counter.subscribe(subscriber);

    expect(subscriber.lastValue).toStrictEqual(-1);

    storage.counter.put(123);

    expect(subscriber.lastValue).toStrictEqual(123);

    storage.name.put("Bob");

    expect(subscriber.lastValue).toStrictEqual(123);

    storage.counter.put(321);

    expect(subscriber.lastValue).toStrictEqual(321);

    storage.counter.unsubscribe(subscriber);

    storage.counter.put(555);
    expect(subscriber.lastValue).toStrictEqual(321);
  });
});

type User = {
  uid: number;
  name: string;
  level: number,
  emails: string[];
  groups: string[];
};

let ALICE: User = {
  uid: 45,
  name: "alice",
  level: 8,
  emails: ["alice@example.com"],
  groups: ["everyone", "admin"],
};
let BOB: User = {
  uid: 284,
  name: "bob",
  level: 4,
  emails: ["bob@example.com", "robert@example.com"],
  groups: ["everyone"]
};
let CAROL: User = {
  uid: 2,
  name: "carol",
  level: 8,
  emails: [],
  groups: ["everyone", "admin"]
};
let DAVE: User = {
  uid: 17,
  name: "dave",
  level: 1,
  emails: ["dave@example.com", "david@example.com"],
  groups: ["everyone","interns"]
};

// User that should never show up in the index being tested.
let EVE: User = {
  uid: 404,
  name: "eve",
  level: 0,
  emails: [],
  groups: []
};

// Schemas shared by the non-unique-index suites: users indexed by level, and the same collection
// with no index declared (for simulating writes from before the index existed).
const INDEXED_SCHEMA = {
  collections: {
    users: collection<User>()({
      primaryKey: "name",
      nonUniqueIndexes: {
        byLevel: (user: User) => user.level == 0 ? null : user.level
      }
    })
  }
};
const PLAIN_SCHEMA = {
  collections: { users: collection<User>()({ primaryKey: "name" }) }
};
const GROUP_SCHEMA = {
  collections: {
    users: collection<User>()({
      primaryKey: "name",
      nonUniqueIndexes: {
        byGroup: (user: User) => user.groups
      }
    })
  }
};

describe("basic collections with string primary key", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, {
    collections: {
      users: collection<User>()({
        primaryKey: "name"
      })
    }
  });

  expect([...storage.users.list()]).toStrictEqual([]);

  it("supports put", () => {
    // Put out-of-order to make sure lists are in-order.
    storage.users.put(BOB);
    storage.users.put(DAVE);
    storage.users.put(CAROL);
    storage.users.put(ALICE);
  });

  it("stores with primary keys erased", () => {
    expect(mockStorage.kv.get("users:alice")).toStrictEqual({...ALICE, name: null});
    expect(mockStorage.kv.get("users:bob")).toStrictEqual({...BOB, name: null});
    expect(mockStorage.kv.get("users:carol")).toStrictEqual({...CAROL, name: null});
    expect(mockStorage.kv.get("users:dave")).toStrictEqual({...DAVE, name: null});
  });

  testByName(storage.users);
});

// Accepts both a UniqueIndex and a Collection (which has no rebuild()).
function testByName(index: Pick<UniqueIndex<User, string>, "get" | "list" | "delete">) {
  it("supports get", () => {
    expect(index.get("alice")).toStrictEqual(ALICE);
    expect(index.get("bob")).toStrictEqual(BOB);
    expect(index.get("carol")).toStrictEqual(CAROL);
    expect(index.get("dave")).toStrictEqual(DAVE);
    expect(index.get("eve")).toStrictEqual(undefined);
  });

  it("supports list", () => {
    expect([...index.list()]).toStrictEqual([ALICE, BOB, CAROL, DAVE]);
    expect([...index.list({reverse: true})]).toStrictEqual([DAVE, CAROL, BOB, ALICE]);

    expect([...index.list({prefix: "b"})]).toStrictEqual([BOB]);
    expect([...index.list({start: "bob"})]).toStrictEqual([BOB, CAROL, DAVE]);
    expect([...index.list({startAfter: "bob"})]).toStrictEqual([CAROL, DAVE]);
    expect([...index.list({end: "carol"})]).toStrictEqual([ALICE, BOB]);
    expect([...index.list({start: "bob", end: "dave"})]).toStrictEqual([BOB, CAROL]);
    expect([...index.list({limit: 3})]).toStrictEqual([ALICE, BOB, CAROL]);
    expect([...index.list({limit: 3, reverse: true})]).toStrictEqual([DAVE, CAROL, BOB]);
  });

  it("supports delete", () => {
    expect(index.delete("carol")).toStrictEqual(true);
    expect(index.delete("carol")).toStrictEqual(false);
    expect(index.delete("eve")).toStrictEqual(false);

    expect([...index.list()]).toStrictEqual([ALICE, BOB, DAVE]);
  });
}

describe("basic collections with integer primary key", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, {
    collections: {
      users: collection<User>()({
        primaryKey: "uid"
      })
    }
  });

  expect([...storage.users.list()]).toStrictEqual([]);

  it("supports put", () => {
    // Put out-of-order to make sure lists are in-order.
    storage.users.put(BOB);
    storage.users.put(DAVE);
    storage.users.put(CAROL);
    storage.users.put(ALICE);
  });

  it("stores with keys encoded as sortable variable-length integers", () => {
    expect(mockStorage.kv.get("users:a2")).toStrictEqual(CAROL);
    expect(mockStorage.kv.get("users:b11")).toStrictEqual(DAVE);
    expect(mockStorage.kv.get("users:b2d")).toStrictEqual(ALICE);
    expect(mockStorage.kv.get("users:c11c")).toStrictEqual(BOB);
  });

  testByNumber(storage.users);
});

// Accepts both a UniqueIndex and a Collection (which has no rebuild()).
function testByNumber(index: Pick<UniqueIndex<User, number>, "get" | "list" | "delete">) {
  it("supports get", () => {
    expect(index.get(ALICE.uid)).toStrictEqual(ALICE);
    expect(index.get(BOB.uid)).toStrictEqual(BOB);
    expect(index.get(CAROL.uid)).toStrictEqual(CAROL);
    expect(index.get(DAVE.uid)).toStrictEqual(DAVE);
    expect(index.get(404)).toStrictEqual(undefined);
  });

  it("supports list", () => {
    expect([...index.list()]).toStrictEqual([CAROL, DAVE, ALICE, BOB]);
    expect([...index.list({reverse: true})]).toStrictEqual([BOB, ALICE, DAVE, CAROL]);

    expect([...index.list({start: DAVE.uid})]).toStrictEqual([DAVE, ALICE, BOB]);
    expect([...index.list({startAfter: DAVE.uid})]).toStrictEqual([ALICE, BOB]);
    expect([...index.list({end: ALICE.uid})]).toStrictEqual([CAROL, DAVE]);
    expect([...index.list({start: DAVE.uid, end: BOB.uid})]).toStrictEqual([DAVE, ALICE]);
    expect([...index.list({limit: 3})]).toStrictEqual([CAROL, DAVE, ALICE]);
    expect([...index.list({limit: 3, reverse: true})]).toStrictEqual([BOB, ALICE, DAVE]);
  });

  it("supports delete", () => {
    expect(index.delete(ALICE.uid)).toStrictEqual(true);
    expect(index.delete(ALICE.uid)).toStrictEqual(false);
    expect(index.delete(404)).toStrictEqual(false);

    expect([...index.list()]).toStrictEqual([CAROL, DAVE, BOB]);
  });
}

describe("basic collections with function primary key", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, {
    collections: {
      users: collection<User>()({
        primaryKey: (user: User) => user.name.toUpperCase()
      })
    }
  });

  expect([...storage.users.list()]).toStrictEqual([]);

  it("supports put", () => {
    // Put out-of-order to make sure lists are in-order.
    storage.users.put(BOB);
    storage.users.put(DAVE);
    storage.users.put(CAROL);
    storage.users.put(ALICE);
  });

  it("stores with primary keys intact", () => {
    expect(mockStorage.kv.get("users:ALICE")).toStrictEqual({...ALICE});
    expect(mockStorage.kv.get("users:BOB")).toStrictEqual({...BOB});
    expect(mockStorage.kv.get("users:CAROL")).toStrictEqual({...CAROL});
    expect(mockStorage.kv.get("users:DAVE")).toStrictEqual({...DAVE});
  });

  it("supports various ops", () => {
    expect(storage.users.get("ALICE")).toStrictEqual(ALICE);
    expect(storage.users.get("alice")).toStrictEqual(undefined);

    expect([...storage.users.list()]).toStrictEqual([ALICE, BOB, CAROL, DAVE]);
    expect([...storage.users.list({reverse: true})]).toStrictEqual([DAVE, CAROL, BOB, ALICE]);

    expect([...storage.users.list({prefix: "b"})]).toStrictEqual([]);
    expect([...storage.users.list({prefix: "B"})]).toStrictEqual([BOB]);

    expect(storage.users.delete("CAROL")).toStrictEqual(true);
    expect(storage.users.delete("CAROL")).toStrictEqual(false);
    expect(storage.users.delete("EVE")).toStrictEqual(false);

    expect([...storage.users.list()]).toStrictEqual([ALICE, BOB, DAVE]);
  });
});

describe("unique index by string", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, {
    collections: {
      users: collection<User>()({
        primaryKey: "uid",  // primary key different from index
        uniqueIndexes: {
          byName: (user: User) => user.name === "eve" ? null : user.name,
        }
      })
    }
  });

  expect([...storage.users.byName.list()]).toStrictEqual([]);

  // Put out-of-order to make sure lists are in-order.
  storage.users.put(BOB);
  storage.users.put(DAVE);
  storage.users.put(CAROL);
  storage.users.put(ALICE);

  // Include Eve, who will not be indexed as the index function will return null.
  storage.users.put(EVE);

  testByName(storage.users.byName);

  it("supports updating a record to change the key", () => {
    let ROBERT = {...BOB, name: "robert"};
    storage.users.put(ROBERT);
    expect(storage.users.byName.get("bob")).toStrictEqual(undefined);
    expect(storage.users.byName.get("robert")).toStrictEqual(ROBERT);
    expect([...storage.users.byName.list()]).toStrictEqual([ALICE, DAVE, ROBERT]);
  });

  it("throws on conflict", () => {
    let DAVE2 = {...DAVE, name: "alice"};
    expect(() => storage.users.put(DAVE2)).toThrow(
        new Error("Update conflicts with record '45' in 'users.byName'."));
    expect(storage.users.byName.get("dave")).toStrictEqual(DAVE);
    expect(storage.users.byName.get("alice")).toStrictEqual(ALICE);
  });
});

describe("unique index by number", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, {
    collections: {
      users: collection<User>()({
        primaryKey: "name",  // primary key different from index
        uniqueIndexes: {
          byUid: (user: User) => user.uid === 404 ? null : user.uid
        }
      })
    }
  });

  expect([...storage.users.byUid.list()]).toStrictEqual([]);

  // Put out-of-order to make sure lists are in-order.
  storage.users.put(BOB);
  storage.users.put(DAVE);
  storage.users.put(CAROL);
  storage.users.put(ALICE);

  // Include Eve, who will not be indexed as the index function will return null.
  storage.users.put(EVE);

  testByNumber(storage.users.byUid);

  it("supports updating a record to change the key", () => {
    let BOB500 = {...BOB, uid: 500};
    storage.users.put(BOB500);
    expect(storage.users.byUid.get(BOB.uid)).toStrictEqual(undefined);
    expect(storage.users.byUid.get(500)).toStrictEqual(BOB500);
    expect([...storage.users.byUid.list()]).toStrictEqual([CAROL, DAVE, BOB500]);
  });

  it("throws on conflict", () => {
    let CAROL2 = {...CAROL, uid: DAVE.uid};
    expect(() => storage.users.put(CAROL2)).toThrow(
        new Error("Update conflicts with record 'dave' in 'users.byUid'."));
    expect(storage.users.byUid.get(CAROL.uid)).toStrictEqual(CAROL);
    expect(storage.users.byUid.get(DAVE.uid)).toStrictEqual(DAVE);
  });
});

describe("unique index by array", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, {
    collections: {
      users: collection<User>()({
        primaryKey: "name",
        uniqueIndexes: {
          byEmail: (user: User) => user.emails
        }
      })
    }
  });

  expect([...storage.users.byEmail.list()]).toStrictEqual([]);

  storage.users.put(BOB);
  storage.users.put(DAVE);
  storage.users.put(CAROL);
  storage.users.put(ALICE);

  let index: UniqueIndex<User, string> = storage.users.byEmail;

  it("supports get", () => {
    expect(index.get("alice@example.com")).toStrictEqual(ALICE);
    expect(index.get("bob@example.com")).toStrictEqual(BOB);
    expect(index.get("robert@example.com")).toStrictEqual(BOB);
    expect(index.get("carol@example.com")).toStrictEqual(undefined);  // CAROL has no email
    expect(index.get("dave@example.com")).toStrictEqual(DAVE);
    expect(index.get("david@example.com")).toStrictEqual(DAVE);
  });

  it("supports list", () => {
    expect([...index.list({dedupe: true})]).toStrictEqual([ALICE, BOB, DAVE]);
    expect([...index.list()]).toStrictEqual([ALICE, BOB, DAVE, DAVE, BOB]);

    expect([...index.list({prefix: "dav"})]).toStrictEqual([DAVE, DAVE]);
    expect([...index.list({prefix: "dav", dedupe: true})]).toStrictEqual([DAVE]);

    expect([...index.list({start: "b", end: "e"})]).toStrictEqual([BOB, DAVE, DAVE]);
    expect([...index.list({start: "b", end: "davf"})]).toStrictEqual([BOB, DAVE]);

    expect([...index.list({limit: 3})]).toStrictEqual([ALICE, BOB, DAVE]);
    expect([...index.list({limit: 3, reverse: true})]).toStrictEqual([BOB, DAVE, DAVE]);
  });

  it("supports delete", () => {
    expect(index.delete("robert@example.com")).toStrictEqual(true);
    expect(index.delete("bob@example.com")).toStrictEqual(false);
    expect(index.delete("robert@example.com")).toStrictEqual(false);
    expect(index.delete("carol@example.com")).toStrictEqual(false);

    expect([...index.list()]).toStrictEqual([ALICE, DAVE, DAVE]);
  });

  let DAVE2 = {...DAVE, emails: ["dave@example.com"]};
  it("supports updating a record to change the key", () => {
    storage.users.put(DAVE2);
    expect(storage.users.byEmail.get("dave@example.com")).toStrictEqual(DAVE2);
    expect(storage.users.byEmail.get("david@example.com")).toStrictEqual(undefined);
  });

  let DAVE3 = {...DAVE, emails: ["dave@example.com", "alice@example.com"]};
  it("throws on conflict", () => {
    expect(() => storage.users.put(DAVE3)).toThrow(
        new Error("Update conflicts with record 'alice' in 'users.byEmail'."));
    expect(storage.users.byEmail.get("dave@example.com")).toStrictEqual(DAVE2);
    expect(storage.users.byEmail.get("alice@example.com")).toStrictEqual(ALICE);
  });
});

describe("non-unique index by number", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, INDEXED_SCHEMA);

  expect([...storage.users.byLevel.list()]).toStrictEqual([]);

  storage.users.put(BOB);
  storage.users.put(DAVE);
  storage.users.put(CAROL);
  storage.users.put(ALICE);
  storage.users.put(EVE);

  let index: NonUniqueIndex<User, number> = storage.users.byLevel;

  it("supports get", () => {
    expect([...index.get(8)]).toStrictEqual([ALICE, CAROL]);
    expect([...index.get(4)]).toStrictEqual([BOB]);
    expect([...index.get(1)]).toStrictEqual([DAVE]);
    expect([...index.get(3)]).toStrictEqual([]);
  });

  it("supports list", () => {
    expect([...index.list()]).toStrictEqual([DAVE, BOB, ALICE, CAROL]);
    expect([...index.list({reverse: true})]).toStrictEqual([CAROL, ALICE, BOB, DAVE]);

    expect([...index.list({start: 4})]).toStrictEqual([BOB, ALICE, CAROL]);
    expect([...index.list({startAfter: 4})]).toStrictEqual([ALICE, CAROL]);
    expect([...index.list({end: 8})]).toStrictEqual([DAVE, BOB]);
    expect([...index.list({start: 4, end: 8})]).toStrictEqual([BOB]);
    expect([...index.list({limit: 2})]).toStrictEqual([DAVE, BOB]);
    expect([...index.list({limit: 2, reverse: true})]).toStrictEqual([CAROL, ALICE, BOB]);
  });

  it("supports delete", () => {
    expect(index.delete(8)).toStrictEqual(2);
    expect(index.delete(8)).toStrictEqual(0);
    expect(index.delete(0)).toStrictEqual(0);

    expect([...index.list()]).toStrictEqual([DAVE, BOB]);
  });
});

describe("non-unique index by array", () => {
  let mockStorage = makeMockStorage();
  let storage = createTypedStorage(mockStorage, {
    collections: {
      users: collection<User>()({
        primaryKey: "name",
        nonUniqueIndexes: {
          byGroup: (user: User) => user.groups
        }
      })
    }
  });

  expect([...storage.users.byGroup.list()]).toStrictEqual([]);

  storage.users.put(BOB);
  storage.users.put(DAVE);
  storage.users.put(CAROL);
  storage.users.put(ALICE);
  storage.users.put(EVE);

  let index: NonUniqueIndex<User, string> = storage.users.byGroup;

  it("supports get", () => {
    expect([...index.get("admin")]).toStrictEqual([ALICE, CAROL]);
    expect([...index.get("everyone")]).toStrictEqual([ALICE, BOB, CAROL, DAVE]);
    expect([...index.get("interns")]).toStrictEqual([DAVE]);
    expect([...index.get("nobody")]).toStrictEqual([]);
  });

  it("supports list", () => {
    expect([...index.list()]).toStrictEqual([ALICE, CAROL, ALICE, BOB, CAROL, DAVE, DAVE]);
    expect([...index.list({dedupe: true})]).toStrictEqual([ALICE, CAROL, BOB, DAVE]);
    expect([...index.list({reverse: true})]).toStrictEqual(
        [DAVE, DAVE, CAROL, BOB, ALICE, CAROL, ALICE]);

    expect([...index.list({start: "everyone"})]).toStrictEqual([ALICE, BOB, CAROL, DAVE, DAVE]);
    expect([...index.list({startAfter: "everyone"})]).toStrictEqual([DAVE]);
    expect([...index.list({end: "everyone"})]).toStrictEqual([ALICE, CAROL]);
    expect([...index.list({start: "e", end: "f"})]).toStrictEqual([ALICE, BOB, CAROL, DAVE]);
    expect([...index.list({limit: 2})]).toStrictEqual([ALICE, CAROL, ALICE, BOB, CAROL, DAVE]);
    expect([...index.list({limit: 2, reverse: true})]).toStrictEqual(
        [DAVE, DAVE, CAROL, BOB, ALICE]);
  });

  it("supports delete", () => {
    expect(index.delete("admin")).toStrictEqual(2);
    expect(index.delete("admin")).toStrictEqual(0);
    expect(index.delete("nobody")).toStrictEqual(0);

    expect([...index.list()]).toStrictEqual([BOB, DAVE, DAVE]);
  });
});

describe("non-unique index rebuild", () => {
  it("backfills an index declared after records were written", () => {
    let mockStorage = makeMockStorage();
    let legacy = createTypedStorage(mockStorage, PLAIN_SCHEMA);
    legacy.users.put(BOB);
    legacy.users.put(ALICE);
    legacy.users.put(CAROL);
    legacy.users.put(EVE);

    let storage = createTypedStorage(mockStorage, INDEXED_SCHEMA);

    // Declared over pre-existing records, the index starts empty -- and resolving one of those
    // records would throw on the index's remove.
    expect([...storage.users.byLevel.list()]).toStrictEqual([]);
    expect(() => storage.users.put({...ALICE, level: 0})).toThrow("inconsistent");

    storage.users.byLevel.rebuild();
    expect([...storage.users.byLevel.list()]).toStrictEqual([BOB, ALICE, CAROL]);
    expect([...storage.users.byLevel.get(8)]).toStrictEqual([ALICE, CAROL]);

    // Writes after the rebuild keep the index consistent, including key removal.
    storage.users.put({...ALICE, level: 0});
    expect([...storage.users.byLevel.list()]).toStrictEqual([BOB, CAROL]);
  });

  it("backfills a multi-key index (array index function)", () => {
    let mockStorage = makeMockStorage();
    let legacy = createTypedStorage(mockStorage, PLAIN_SCHEMA);
    legacy.users.put(ALICE);
    legacy.users.put(BOB);
    legacy.users.put(DAVE);
    legacy.users.put(EVE);  // no groups: unindexed

    let storage = createTypedStorage(mockStorage, GROUP_SCHEMA);
    storage.users.byGroup.rebuild();

    expect([...storage.users.byGroup.get("everyone")]).toStrictEqual([ALICE, BOB, DAVE]);
    expect([...storage.users.byGroup.get("admin")]).toStrictEqual([ALICE]);
    expect([...storage.users.byGroup.get("interns")]).toStrictEqual([DAVE]);
    expect([...storage.users.byGroup.list({dedupe: true})]).toStrictEqual([ALICE, BOB, DAVE]);
  });

  it("reclaims orphaned child rows and never reuses child-group ids", () => {
    let mockStorage = makeMockStorage();
    let storage = createTypedStorage(mockStorage, INDEXED_SCHEMA);
    storage.users.put(ALICE);  // level 8
    storage.users.put(BOB);    // level 4

    // A child row whose parent key vanished (e.g. a partially-applied wipe): unreachable from
    // the parent keys, but still swept by rebuild's raw-range deleteAll.
    mockStorage.kv.put("users.byLevel.999:zombie", {});
    let preIds = new Set([...mockStorage.kv.list({prefix: "users.byLevel:"})].map(([, id]) => id));
    let counterBefore = mockStorage.kv.get<number>("users.byLevel#")!;

    storage.users.byLevel.rebuild();

    expect(mockStorage.kv.get("users.byLevel.999:zombie")).toStrictEqual(undefined);
    // The unique-id counter survives the wipe, so the rebuilt groups get fresh ids.
    expect(mockStorage.kv.get<number>("users.byLevel#")).toBeGreaterThanOrEqual(counterBefore);
    for (let [, id] of mockStorage.kv.list({prefix: "users.byLevel:"})) {
      expect(preIds.has(id)).toStrictEqual(false);
    }
    expect([...storage.users.byLevel.list()]).toStrictEqual([BOB, ALICE]);
  });

  it("discards stale entries for records changed behind the index's back", () => {
    let mockStorage = makeMockStorage();
    let storage = createTypedStorage(mockStorage, INDEXED_SCHEMA);
    storage.users.put(ALICE);
    storage.users.put(DAVE);

    // Mutate through a view without the index, leaving it stale: DAVE gone, BOB unindexed.
    let legacy = createTypedStorage(mockStorage, PLAIN_SCHEMA);
    legacy.users.delete("dave");
    legacy.users.put(BOB);

    storage.users.byLevel.rebuild();
    expect([...storage.users.byLevel.list()]).toStrictEqual([BOB, ALICE]);
    expect([...storage.users.byLevel.get(1)]).toStrictEqual([]);
  });
});

describe("unique index rebuild", () => {
  const UNIQUE_SCHEMA = {
    collections: {
      users: collection<User>()({
        primaryKey: "name",
        uniqueIndexes: {
          byUid: (user: User) => user.uid === 404 ? null : user.uid
        }
      })
    }
  };

  it("backfills an index declared after records were written", () => {
    let mockStorage = makeMockStorage();
    let legacy = createTypedStorage(mockStorage, PLAIN_SCHEMA);
    legacy.users.put(ALICE);
    legacy.users.put(BOB);
    legacy.users.put(EVE);

    let storage = createTypedStorage(mockStorage, UNIQUE_SCHEMA);

    // Declared over pre-existing records, the index starts empty -- and changing one of those
    // records' keys would throw on the index's remove.
    expect(storage.users.byUid.get(ALICE.uid)).toStrictEqual(undefined);
    expect(() => storage.users.put({...ALICE, uid: 46})).toThrow("inconsistent");

    storage.users.byUid.rebuild();
    expect(storage.users.byUid.get(ALICE.uid)).toStrictEqual(ALICE);
    expect(storage.users.byUid.get(BOB.uid)).toStrictEqual(BOB);
    expect(storage.users.byUid.get(EVE.uid)).toStrictEqual(undefined);  // null-keyed, unindexed

    // Writes after the rebuild keep the index consistent, including key changes.
    storage.users.put({...ALICE, uid: 46});
    expect(storage.users.byUid.get(ALICE.uid)).toStrictEqual(undefined);
    expect(storage.users.byUid.get(46)).toStrictEqual({...ALICE, uid: 46});
  });

  it("throws when two records derive the same key, leaving no partial index", () => {
    let mockStorage = makeMockStorage();
    let legacy = createTypedStorage(mockStorage, PLAIN_SCHEMA);
    legacy.users.put(ALICE);
    legacy.users.put({...BOB, uid: ALICE.uid});

    let storage = createTypedStorage(mockStorage, UNIQUE_SCHEMA);
    expect(() => storage.users.byUid.rebuild()).toThrow("conflicts");

    // The rebuild runs in one transaction: the entries added before the conflict rolled back.
    expect(storage.users.byUid.get(ALICE.uid)).toStrictEqual(undefined);
    expect([...storage.users.byUid.list()]).toStrictEqual([]);
  });
});

describe("non-unique index ranged get", () => {
  it("ranges and pages within one group by primary key", () => {
    let storage = createTypedStorage(makeMockStorage(), GROUP_SCHEMA);
    storage.users.put(BOB);
    storage.users.put(DAVE);
    storage.users.put(CAROL);
    storage.users.put(ALICE);

    let index = storage.users.byGroup;
    expect([...index.get("everyone", {start: "bob"})]).toStrictEqual([BOB, CAROL, DAVE]);
    expect([...index.get("everyone", {startAfter: "bob"})]).toStrictEqual([CAROL, DAVE]);
    expect([...index.get("everyone", {end: "carol"})]).toStrictEqual([ALICE, BOB]);
    expect([...index.get("everyone", {limit: 2})]).toStrictEqual([ALICE, BOB]);
    expect([...index.get("everyone", {reverse: true})]).toStrictEqual([DAVE, CAROL, BOB, ALICE]);
    expect([...index.get("admin", {reverse: true, limit: 1})]).toStrictEqual([CAROL]);
    expect([...index.get("nobody", {limit: 2})]).toStrictEqual([]);
  });

  it("pages a numeric-pk group descending with an exclusive end", () => {
    type Row = {id: number, group: string};
    let storage = createTypedStorage(makeMockStorage(), {
      collections: {
        rows: collection<Row>()({
          primaryKey: "id",
          nonUniqueIndexes: {
            byGroup: (row: Row) => row.group
          }
        })
      }
    });
    for (let id = 0; id < 7; id++) {
      storage.rows.put({id, group: id % 2 === 0 ? "even" : "odd"});
    }

    // The cursored-history shape: a newest-first page strictly below the cursor.
    let index = storage.rows.byGroup;
    expect([...index.get("even", {end: 6, reverse: true, limit: 2})].map(r => r.id))
        .toStrictEqual([4, 2]);
    expect([...index.get("even", {reverse: true, limit: 2})].map(r => r.id))
        .toStrictEqual([6, 4]);
    expect([...index.get("even", {end: 2})].map(r => r.id)).toStrictEqual([0]);
  });
});
