// The `env.EXPORTS` binding: the RpcTarget behind the `Exports` interface (exports-binding.d.ts
// defines the agent-facing contract), present in the agent's executeCode env.
//
// Minted per loopback session by the overseer's binding-loopback dispatch (startGatekeeperSession,
// target type "exports"). It names gadgets by their binding names in the env it accompanies, from
// the map it is minted with, so it reaches only gadgets that env already reaches. Each is exported
// as the calling chat sees it -- the same view the env's own gadget stubs have.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { GadgetExportFormat, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { Exports } from "./exports-binding";

/** What the binding needs from the overseer: the export pipeline behind GadgetClient's. */
export interface ExportsHost {
  getGadgetExportFormats(gadgetId: WorkpieceId, chatId?: number): Promise<GadgetExportFormat[]>;
  exportGadget(gadgetId: WorkpieceId, formatId: string, chatId?: number)
      : Promise<ReadableStream<Uint8Array>>;
}

/** The `env.EXPORTS` binding. */
@validateRpc()
export class ExportsImpl extends RpcTarget implements Exports {
  // Real private fields: RPC exposes an RpcTarget's properties as well as its methods, so
  // TypeScript-only privacy would leak the overseer to the executed code.
  #host: ExportsHost;
  #gadgets: Record<string, WorkpieceId>;
  #chatId: number;

  /** `gadgets` maps each gadget binding name in the caller's env to its gadget. */
  constructor(host: ExportsHost, gadgets: Record<string, WorkpieceId>, chatId: number) {
    super();
    this.#host = host;
    this.#gadgets = gadgets;
    this.#chatId = chatId;
  }

  async getFormats(gadget: string): Promise<GadgetExportFormat[]> {
    return this.#host.getGadgetExportFormats(this.#gadgetId(gadget), this.#chatId);
  }

  async export(gadget: string, formatId: string): Promise<ReadableStream<Uint8Array>> {
    return this.#host.exportGadget(this.#gadgetId(gadget), formatId, this.#chatId);
  }

  #gadgetId(name: string): WorkpieceId {
    // Own properties only: the map arrives as a plain object, so "constructor" must not resolve.
    if (!Object.hasOwn(this.#gadgets, name)) {
      throw new Error(`There is no gadget named "${name}" in your env.`);
    }
    return this.#gadgets[name]!;
  }
}
