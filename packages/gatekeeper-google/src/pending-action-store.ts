/** Synchronous Durable Object KV operations used by pending action storage. */
export interface PendingActionStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}

const ACTION_PREFIX = "pending:action:";
const NEXT_ACTION_ID_KEY = "pending:nextActionId";

/** Shared durable storage for gatekeeper actions awaiting approval callbacks. */
export class PendingActionStore<Action> {
  constructor(private storage: PendingActionStorage) {}

  /** Persist an action and return its binding-local sequential ID. */
  submit(action: Action): number {
    let id = this.storage.get<number>(NEXT_ACTION_ID_KEY) ?? 1;
    this.storage.put(NEXT_ACTION_ID_KEY, id + 1);
    this.storage.put(this.#actionKey(id), action);
    return id;
  }

  /** Return one pending action, if present. */
  get(id: number): Action | undefined {
    return this.storage.get<Action>(this.#actionKey(id));
  }

  /** Replace one pending action. */
  put(id: number, action: Action): void {
    this.storage.put(this.#actionKey(id), action);
  }

  /** Return pending actions in ascending action-ID order. */
  list(): { id: number; action: Action }[] {
    return [...this.storage.list<Action>({ prefix: ACTION_PREFIX })]
      .map(([key, action]) => ({ id: Number(key.slice(ACTION_PREFIX.length)), action }))
      .filter(({ id }) => Number.isFinite(id))
      .toSorted((a, b) => a.id - b.id);
  }

  /** Remove one pending action. */
  remove(id: number): void {
    this.storage.delete(this.#actionKey(id));
  }

  #actionKey(id: number): string {
    return `${ACTION_PREFIX}${id}`;
  }
}
