import { RpcSession, RpcStub, RpcTarget, type RpcTransport } from "capnweb";

// This code runs in the main world of the remote browser used for rendering the
// Gadget UI for export. It runs before the Gadget client module is loaded and
// is mainly responsible for setting up the RPC session to the Gadget server.

declare global {
  /** Data URL containing the Gadget client module. */
  var __workshopExportClientUrl: string;
  /** Sends a Cap'n Web RPC message from the Worker to the browser-side session. */
  var __workshopExportSendToBrowser: (message: string) => void;
  /** Receives the next Cap'n Web RPC message from the browser-side session. */
  var __workshopExportReceiveFromBrowser: () => Promise<string>;
  /** Settles when the Gadget client module has finished loading. */
  var __workshopExportModulePromise: Promise<Record<string, unknown>>;
  var __workshopExportRuntime: {
    gadget: unknown;
    RpcStub: typeof RpcStub;
    RpcTarget: typeof RpcTarget;
  };
}

/**
 * Queue for Cap'n Web messages sent between the browser and Worker. This runs on the
 * browser side of the CDP interface to prevent Worker resource exhaustion by a misbehaving
 * Gadget.
 */
class AsyncMessageQueue {
  #messages: string[] = [];
  #receivers: Array<(message: string) => void> = [];

  push(message: string): void {
    const receiver = this.#receivers.shift();
    if (receiver) {
      receiver(message);
      return;
    }
    this.#messages.push(message);
  }

  next(): Promise<string> {
    const message = this.#messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    return new Promise(resolve => this.#receivers.push(resolve));
  }
}

const fromWorker = new AsyncMessageQueue();
globalThis.__workshopExportSendToBrowser = message => fromWorker.push(message);
const toWorker = new AsyncMessageQueue();
globalThis.__workshopExportReceiveFromBrowser = () => toWorker.next();

class WorkerRpcTransport implements RpcTransport {
  send(message: string): Promise<void> {
    toWorker.push(message);
    return Promise.resolve();
  }

  receive(): Promise<string> {
    return fromWorker.next();
  }
}

const workerSession = new RpcSession<any>(new WorkerRpcTransport());
globalThis.__workshopExportRuntime = {
  gadget: workerSession.getRemoteMain(),
  RpcStub,
  RpcTarget,
};

const clientUrl = globalThis.__workshopExportClientUrl;
delete (globalThis as Partial<typeof globalThis>).__workshopExportClientUrl;
globalThis.__workshopExportModulePromise = import(clientUrl);
