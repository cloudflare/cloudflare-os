import { RpcTarget } from "cloudflare:workers";

const responseTargets = new Map<string, {available: boolean; calls: number}>();

/** A persistent external response target whose outage a test can end independently of the DO. */
export class FakeChatResponseTarget extends RpcTarget {
  constructor(private readonly name: string) { super(); }

  setAvailable(available: boolean): void {
    responseTargets.set(this.name, {available, calls: this.calls()});
  }

  calls(): number {
    return responseTargets.get(this.name)?.calls ?? 0;
  }

  async onGadgetResponse(): Promise<void> {
    const state = responseTargets.get(this.name)!;
    state.calls++;
    if (!state.available) throw new Error("Response target unavailable");
  }
}
