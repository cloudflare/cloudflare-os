import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { CollaboratorInfo, CollaboratorRole } from "./api.ts";

/** A completed Gadget response that should be delivered back to the chat gateway. */
export type GadgetResponse = {
  text: string;
};

/** RPC target provided by the chat gateway for the backend's eventual response. */
export interface ChatGatewayRpcTarget extends RpcTarget {
  /**
   * Deliver the completed Gadget response. Implementations must be idempotent because delivery is
   * at-least-once when response target acknowledgements fail.
   */
  onGadgetResponse(response: GadgetResponse): Promise<void>;
}

/** External message submission accepted by the backend gateway. */
export type SubmitExternalMessageInput = {
  // Selects the Gadgets account used to submit the message.
  // The backend trusts the gateway: supplying this email grants access as that account.
  callerEmail: string;
  // Selects the workspace to create or reuse.
  gadgetKey: string;
  // Selects the chat to create or reuse.
  chatKey: string;
  // Deduplicates the originating message and correlates the response target.
  messageKey: string;
  // Names the workspace if it must be created.
  gadgetTitle: string;
  // User text sent to Gadgets.
  prompt: string;
  // Persistent target invoked when the Gadget response is ready.
  chatGatewayRpcTarget: RpcStub<ChatGatewayRpcTarget>;
};

/** Submission result returned by the backend gateway. */
export type SubmitExternalMessageResult =
  | {
      accepted: true;
      chatPath: string;
    }
  | {
      accepted: false;
      // User-facing explanation of an actionable submission rejection.
      message: string;
    };

/** Grant a role to an existing account on a gateway-owned workspace. */
export type AddExternalCollaboratorInput = {
  // Selects the workspace (same gadgetKey namespace as submitExternalMessage).
  gadgetKey: string;
  // Username/email the gateway has already authenticated. Never accept a model- or
  // client-supplied identity here — the gateway is the trusted boundary.
  username: string;
  role: CollaboratorRole;
  note?: string;
};

/** Service binding RPC interface used by chat gateway workers. */
export interface ExternalMessageGateway {
  /** Submit an external chat message for Gadget routing and execution. */
  submitExternalMessage(input: SubmitExternalMessageInput): Promise<SubmitExternalMessageResult>;

  /**
   * Add a collaborator to a gateway-owned workspace, acting as the workspace owner.
   *
   * Returns null when `username` has no account. Gateways must only pass usernames they have
   * authenticated (e.g. Teams roster → Graph email). Throws when sharing is prohibited.
   */
  addCollaborator(input: AddExternalCollaboratorInput): Promise<CollaboratorInfo | null>;
}
