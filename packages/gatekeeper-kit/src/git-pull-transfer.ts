import { RpcTarget } from "cloudflare:workers";
import type {
  GitOid, GitPullHints, GitPullStatus, GitPullTransfer,
} from "@gadgets/workshop-shared/gatekeeper";
import { pullGitPack } from "./git-transport";

/** Keep the producer's terminal result reachable even if RPC replaces a stream exception. */
class GitPullTransferImpl extends RpcTarget implements GitPullTransfer {
  #pack: ReadableStream<Uint8Array> | undefined;
  #status: () => GitPullStatus;

  constructor(pack: ReadableStream<Uint8Array>, status: () => GitPullStatus) {
    super();
    this.#pack = pack;
    this.#status = status;
  }

  async stream(): Promise<ReadableStream<Uint8Array>> {
    const pack = this.#pack;
    if (pack === undefined) throw new Error("git pull stream was already claimed");
    this.#pack = undefined;
    return pack;
  }

  async status(): Promise<GitPullStatus> {
    return this.#status();
  }

  [Symbol.dispose](): void {
    // Once claimed, the consumer owns cancellation independently of this status capability.
    const pack = this.#pack;
    this.#pack = undefined;
    pack?.cancel().catch(() => {});
  }
}

/** Start a provider-neutral fetch without buffering the pack or exposing transport credentials. */
export async function startGitPull(
  fetchUploadPack: (requestBody: Uint8Array) => Promise<Response>,
  oids: GitOid[],
  hints: GitPullHints,
): Promise<GitPullTransfer> {
  let status: GitPullStatus = {state: "streaming"};
  const pack = await pullGitPack(fetchUploadPack, oids, hints, terminal => {
    if (status.state === "streaming") status = terminal;
  });
  return new GitPullTransferImpl(pack, () => status);
}
