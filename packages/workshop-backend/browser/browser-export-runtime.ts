import { RpcSession, RpcStub as Stub, RpcTarget as Target, type RpcTransport } from "capnweb";

// This code runs in the main world of the remote browser used for rendering the
// Gadget UI for export. It runs before the Gadget client module is loaded and
// is mainly responsible for setting up the RPC session to the Gadget server.
//
// It is a module importing "capnweb" through the page's import map, so a Gadget
// module importing "capnweb" gets the same instance, whose RpcTarget the
// session recognizes.

declare global {
  /** Data URL containing the Gadget client module. */
  var __workshopExportClientUrl: string;
  /**
   * Whether to start the UI by calling `main(gadget, host)` on the client module's
   * default export (see `UiPage.callsMain`), rather than setting globals.
   */
  var __workshopExportCallsMain: boolean;
  /** Sends a Cap'n Web RPC message from the Worker to the browser-side session. */
  var __workshopExportSendToBrowser: (message: string) => void;
  /** Receives the next Cap'n Web RPC message from the browser-side session. */
  var __workshopExportReceiveFromBrowser: () => Promise<string>;
  /**
   * Settles when the Gadget client module has finished loading, and for a UI
   * that calls `main()`, when that settles.
   */
  var __workshopExportModulePromise: Promise<unknown>;
  /** The Gadget's server, a global in a legacy client module as in the live iframe. */
  var gadget: unknown;
  var RpcStub: typeof Stub;
  var RpcTarget: typeof Target;
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

/** The session's main object: the Gadget's server and its host, as in the live iframe. */
interface ExportPageRoot {
  gadget: any;
  host: any;
}

const workerSession = new RpcSession<ExportPageRoot>(new WorkerRpcTransport());
const root = workerSession.getRemoteMain();
const gadget = root.gadget;
const host = root.host;

const clientUrl = globalThis.__workshopExportClientUrl;
const callsMain = globalThis.__workshopExportCallsMain;
delete (globalThis as Partial<typeof globalThis>).__workshopExportClientUrl;
delete (globalThis as Partial<typeof globalThis>).__workshopExportCallsMain;
if (callsMain) {
  // Settles with nothing: the promise is global, so whatever main() returns, such as a
  // capability, must not be reachable through it.
  globalThis.__workshopExportModulePromise = import(clientUrl).then(async entry => {
    const main = entry.default?.main;
    if (typeof main !== "function") {
      throw new Error("client.js's default export has no main() function.");
    }
    await main.call(entry.default, gadget, host);
  });
} else {
  globalThis.gadget = gadget;
  globalThis.RpcStub = Stub;
  globalThis.RpcTarget = Target;
  globalThis.__workshopExportModulePromise = import(clientUrl);
}
