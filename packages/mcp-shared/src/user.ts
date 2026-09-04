import { WorkerEntrypoint } from "cloudflare:workers";
import type { AccountDescription, AvatarImage } from "@gadgets/workshop-shared/gatekeeper";

import type { ConnectedServer } from "./account.js";
import { generateNonce } from "./connect-nonce.js";

/** Props shared by both MCP account capabilities. */
export type McpGatekeeperUserProps = { accountObjectId: string };

/** The account operations used by the common MCP account lifecycle. */
export interface McpGatekeeperUserAccount {
  /** Returns the connected MCP server. */
  getServer(): Promise<ConnectedServer>;
  /** Revokes the account and its credentials. */
  revoke(): Promise<void>;
  /** Starts a reconnect with a fresh initiation nonce. */
  prepareReconnect(initiationNonce: string): Promise<void>;
  /** Makes the credentials staged by the last reconnect live. */
  commitReconnect(): Promise<void>;
}

/** Connector-owned values used by the common MCP account lifecycle. */
export interface McpGatekeeperUserContext {
  /** The connected account capability. */
  account: McpGatekeeperUserAccount;
  /** Connector-specific account avatar. */
  avatar: AvatarImage;
  /** Public URL of the connector Worker, without a trailing slash. */
  baseUrl: string;
}

/** Symbol-named hook that cannot be invoked as an RPC method. */
export const mcpGatekeeperUserContext = Symbol("mcpGatekeeperUserContext");

/** Common account lifecycle for MCP gatekeeper user entrypoints. */
export abstract class McpGatekeeperUserBase<E>
  extends WorkerEntrypoint<E, McpGatekeeperUserProps> {

  /** Supplies connector-owned lifecycle values without exposing an RPC-addressable method. */
  protected abstract [mcpGatekeeperUserContext](): McpGatekeeperUserContext;

  /** Describes the connected MCP account. */
  async describe(): Promise<AccountDescription> {
    const { account, avatar } = this[mcpGatekeeperUserContext]();
    const server = await account.getServer();
    return {
      displayName: server.serverName,
      uniqueName: server.endpoint,
      avatar,
    };
  }

  /** MCP OAuth does not establish a sign-in identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** MCP OAuth scopes cannot be expanded after connection. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Revokes the connected account. */
  async revoke(): Promise<void> {
    await this[mcpGatekeeperUserContext]().account.revoke();
  }

  /** Makes the credentials staged by the last reconnect live (see GatekeeperUser.commitReconnect). */
  async commitReconnect(): Promise<void> {
    await this[mcpGatekeeperUserContext]().account.commitReconnect();
  }

  /** Starts reconnecting the connected account. */
  async reconnect(): Promise<{ url: string }> {
    const { account, baseUrl } = this[mcpGatekeeperUserContext]();
    const initiationNonce = generateNonce();
    await account.prepareReconnect(initiationNonce);
    return {
      url: `${baseUrl}/${this.ctx.props.accountObjectId}/${initiationNonce}`,
    };
  }
}
