// The per-binding gatekeeper Durable Object: one instance per binding of an Acme Service
// connection. It owns the binding's action journal, pins the user the connection belongs to, and
// mints the capabilities gadgets hold (acme-session.ts). Every request to the provider runs
// through the account's credential source.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { actions, type AcmeAction, type AcmeActionHost } from "./acme-actions";
import { createApi } from "./acme-api";
import {
  accountSource, accountStub, itemSubresourceId, type AcmeVerifierApi, type Identity,
} from "./acme-credentials";
import type { AcmeGatekeeperImplProps, Env } from "./acme-env";
import { AcmeItemImpl, type SessionHost } from "./acme-session";
import { itemUrl } from "./acme-urls";
import type { AcmeItem } from "./types";
import TYPES_CODE from "./types.txt";

/** How long the connected identity is trusted in memory before the account is asked again. */
const IDENTITY_MEMO_MS = 60 * 1000;

// Storage keys of this class's own. The kit's journal owns those under `acme:`.
const PINNED_KEY = "pinned";

@validateRpc()
export class AcmeGatekeeperImpl extends DurableObject<Env, AcmeGatekeeperImplProps>
  implements Gatekeeper<AcmeItem> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #journal = new ActionJournal<AcmeAction>(this.ctx.storage.kv, { namespace: "acme" });
  #identity?: { value: Identity; at: number };

  // Each observer's own connection answers for the IDs a read reported.
  readonly #verifyAccess = observerAccessVerifier<AcmeVerifierApi>({
    hasCollectionAccess: (verifier, ids) => verifier.checkSubresourceAccess([...ids]),
  });

  // What apply handlers may do. A plain object, not this class: its stub is the overseer's.
  readonly #actionHost: AcmeActionHost = {
    write: async op => {
      await this.#me();
      return await this.#creds.run(creds => op(createApi(creds.accessToken, "write")));
    },
  };

  readonly #actions = actions.bind(this.#journal, this.#actionHost);

  readonly #sessionHost: SessionHost = {
    read: async op => {
      await this.#me();
      return await this.#creds.run(creds => op(createApi(creds.accessToken)), { replayable: true });
    },
    pending: () => this.#journal.listPending().map(({ action }) => action),
    submit: async (queue, kind, payload) => {
      await this.#actions.submit(queue, kind, payload, { fence: { generation: (await this.#me()).userId } });
    },
  };

  async describe(): Promise<ResourceDescription> {
    // Descriptions are visible outside observation authorization, so they name objects by ID only.
    return {
      url: itemUrl(this.ctx.props.itemId),
      title: `Acme Service item ${this.ctx.props.itemId}`,
      snippet: "Acme Service",
      suggestedBindingName: "ACME_ITEM",
      tsType: "AcmeItem",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<AcmeItem> {
    return new AcmeItemImpl(this.#sessionHost, approvalQueue.dup(), this.ctx.props.itemId);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    // Fenced on the user the binding is pinned to, as each action was submitted (see `actions`).
    const { userId } = await this.#me();
    await this.#actions.apply(actionId, { generation: userId });
  }

  async rejectAction(actionId: number): Promise<void> {
    await this.#actions.reject(actionId);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return { message: "Acme Service changes can't be undone automatically.", canRetry: false };
  }

  /** A new gatekeeper: no read was ever made without reporting its subresources. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /**
   * Allows an observer only if their own connection can read every subresource (see
   * `UserAccount.checkSubresourceAccess`). Fails the whole call for an ID this binding never
   * reports rather than guess what it names.
   */
  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    const reported = itemSubresourceId(this.ctx.props.itemId);
    if (subresources.some(id => id !== reported)) {
      throw new Error("This binding was asked about a subresource it never reported.");
    }
    return await this.#verifyAccess(observers, subresources);
  }

  /** Compatibility only: observers are authorized per read, in verifyObserverAccess(). */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Compatibility only: there is no observer state to remove. */
  async removeObserver(_id: string): Promise<void> {}

  /**
   * The connected user, pinned at the binding's first use. The account already refuses a reconnect
   * as anyone else; the pin keeps a binding from following one regardless.
   */
  async #me(): Promise<Identity> {
    const now = Date.now();
    if (this.#identity && now - this.#identity.at < IDENTITY_MEMO_MS) return this.#identity.value;
    const identity = await accountStub(this.ctx.exports, this.ctx.props.userObjectId).getIdentity();
    const kv = this.ctx.storage.kv;
    const pinned = kv.get<string>(PINNED_KEY);
    if (pinned === undefined) {
      kv.put<string>(PINNED_KEY, identity.userId);
    } else if (pinned !== identity.userId) {
      throw new Error("This binding was made for a different Acme Service user than its connection now uses. " +
        "Remove it and bind the resource again.");
    }
    this.#identity = { value: identity, at: now };
    return identity;
  }
}
