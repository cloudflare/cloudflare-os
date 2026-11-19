/**
 * The pending-action store of the Google Doc and Google Calendar connections, which predate the
 * kit's action journal: each queued action under `pending:action:<n>`, numbered from 1.
 */

/** Where a {@link PendingActionStore} keeps the next unused action ID, starting at 1. */
export const PENDING_NEXT_ACTION_ID_KEY = "pending:nextActionId";

export class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #actionKey(id: number): string {
    return `pending:action:${id}`;
  }

  submit(action: Action): number {
    let id = this.#kv.get<number>(PENDING_NEXT_ACTION_ID_KEY) ?? 1;
    this.#kv.put(PENDING_NEXT_ACTION_ID_KEY, id + 1);
    this.#kv.put(this.#actionKey(id), action);
    return id;
  }

  get(id: number): Action | undefined {
    return this.#kv.get<Action>(this.#actionKey(id));
  }

  put(id: number, action: Action): void {
    this.#kv.put(this.#actionKey(id), action);
  }

  list(): {id: number, action: Action}[] {
    return [...this.#kv.list<Action>({prefix: "pending:action:"})]
        .map(([key, action]) => ({id: Number(key.slice("pending:action:".length)), action}))
        .filter(({id}) => Number.isFinite(id))
        .toSorted((a, b) => a.id - b.id);
  }

  remove(id: number): void {
    this.#kv.delete(this.#actionKey(id));
    this.#kv.delete(this.#applyingKey(id));
  }

  #applyingKey(id: number): string {
    return `pending:applying:${id}`;
  }

  /** Records that the overseer has started applying `id`, which proves it received the action. */
  markApplying(id: number): void {
    this.#kv.put(this.#applyingKey(id), true);
  }

  /** Whether the overseer has started applying `id` (see `markApplying`). */
  isApplying(id: number): boolean {
    return this.#kv.get<boolean>(this.#applyingKey(id)) === true;
  }
}
