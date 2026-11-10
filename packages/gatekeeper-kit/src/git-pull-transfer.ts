import { RpcTarget } from "cloudflare:workers";
import type {
  GitOid, GitPullHints, GitPullStatus, GitPullTransfer, GitShallowInfo,
} from "@gadgets/workshop-shared/gatekeeper";
import { openGitPull } from "./git-transport";

/** Keep the producer's terminal result reachable even if RPC replaces a stream exception. */
class GitPullTransferImpl extends RpcTarget implements GitPullTransfer {
  #pack: ReadableStream<Uint8Array> | undefined;
  #status: () => GitPullStatus;
  #shallowInfo: () => Promise<GitShallowInfo>;

  constructor(pack: ReadableStream<Uint8Array>, status: () => GitPullStatus,
      shallowInfo: () => Promise<GitShallowInfo>) {
    super();
    this.#pack = pack;
    this.#status = status;
    this.#shallowInfo = shallowInfo;
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

  async shallowInfo(): Promise<GitShallowInfo> {
    return this.#shallowInfo();
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
  const {pack, shallowInfo} = await openGitPull(fetchUploadPack, oids, hints, terminal => {
    if (status.state === "streaming") status = terminal;
  });
  return new GitPullTransferImpl(pack, () => status, shallowInfo);
}

/**
 * Offer `pack`, an already-open pack stream, as a transfer whose status follows it: `complete`
 * once it ends, `failed` with its error's message, or `canceled`.
 */
export function gitPullTransferOf(pack: ReadableStream<Uint8Array>, shallow: GitShallowInfo): GitPullTransfer {
  let status: GitPullStatus = {state: "streaming"};
  const settle = (terminal: GitPullStatus) => { if (status.state === "streaming") status = terminal; };
  const reader = pack.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle({state: "complete"});
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        settle({state: "failed", message: error instanceof Error ? error.message : String(error)});
        throw error;
      }
    },
    async cancel(reason) {
      settle({state: "canceled"});
      await reader.cancel(reason);
    },
  }, {highWaterMark: 0});
  return new GitPullTransferImpl(tracked, () => status, async () => shallow);
}
