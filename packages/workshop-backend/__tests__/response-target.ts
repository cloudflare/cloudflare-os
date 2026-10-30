import { RpcTarget } from "cloudflare:workers";
import type { GadgetResponse } from "@gadgets/workshop-shared/external-message-gateway";

const responseTargets = new Map<string, {available: boolean; calls: number; texts: string[]}>();

/** A persistent external response target whose outage a test can end independently of the DO. */
export class FakeChatResponseTarget extends RpcTarget {
  constructor(private readonly name: string) { super(); }

  setAvailable(available: boolean): void {
    responseTargets.set(this.name, {available, calls: this.calls(), texts: this.texts()});
  }

  calls(): number {
    return responseTargets.get(this.name)?.calls ?? 0;
  }

  /** The texts of the responses delivered while it was available. */
  texts(): string[] {
    return responseTargets.get(this.name)?.texts ?? [];
  }

  async onGadgetResponse(response: GadgetResponse): Promise<void> {
    const state = responseTargets.get(this.name)!;
    state.calls++;
    if (!state.available) throw new Error("Response target unavailable");
    state.texts.push(response.text);
  }
}
