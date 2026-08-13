// Talking to an MCP endpoint through an account's stored credentials. Every call a connector makes
// goes through `withClient`, so the transport-session lifecycle lives in one place.
//
// A lapsed transport session is re-established and the call retried once, but only for reads. The
// MCP spec says a 404 on a session-bearing request means the session is gone, implying the request
// was never dispatched, but a 404 from something in front of the server could arrive after the call
// landed. A write is left to fail as outcome-unknown; its approved action is closed, and a person
// must deliberately stage a new one after checking whether the first took effect.

import {
  McpAuthRequiredError,
  McpCallNotDispatchedError,
  McpClient,
  McpSessionExpiredError,
  type ToolCatalog,
}
  from "./client.js";
import { fetchOptions, type InsecureEnv } from "./fetch.js";
import { MAX_TOOLS_PER_SERVER } from "./tools.js";

/** The environment this module reads. Each Worker's own `Env` satisfies it structurally. */
export type ConnectionEnv = InsecureEnv & {
  /** Name this deployment reports to MCP servers during `initialize`. */
  MCP_CLIENT_NAME?: string;
};

export type WithClientOptions = {
  /** False for a call that may have taken effect, so a dropped session is not retried. See above. */
  retryOnExpiry?: boolean;
};

/**
 * Everything an account must hand over before a request can be made. One value rather than two
 * getters: every MCP request needs both, and asking separately costs two serialized round trips to
 * the account Durable Object.
 */
export type McpConnection = {
  /** Bearer token, or null for a public server. */
  authorization: string | null;
  /** Transport session id from a previous `initialize`, if one is cached. */
  sessionId: string | null;
  /**
   * Persisted account generation. Every state write after an await returns this to the account, so
   * work started before a reconnect cannot overwrite the new connection's tokens or session.
   */
  generation: number;
};

/**
 * The part of an account Durable Object that a call needs, structural so this module does not depend
 * on either connector's `McpAccount`.
 */
export type ConnectionAccount = {
  /**
   * `endpoint` binds the credential response to where the caller will send it. An account may be
   * repointed while an older facet still exists; returning current credentials to that facet would
   * send the new server's bearer token to the old server.
   */
  getConnection(endpoint: string): Promise<McpConnection>;
  assertConnectionCurrent(endpoint: string, generation: number): Promise<void>;
  setMcpSessionId(
    endpoint: string,
    generation: number,
    previousSessionId: string | null,
    sessionId: string | null,
  ): Promise<boolean>;
  noteCredentialsExpired(endpoint: string, generation: number): Promise<void>;
};

/** The name this deployment gives when introducing itself to an MCP server. */
export function clientName(env: ConnectionEnv): string {
  return env.MCP_CLIENT_NAME ?? "Gadgets";
}

function notDispatched(err: unknown): McpCallNotDispatchedError {
  if (err instanceof McpCallNotDispatchedError) return err;
  return new McpCallNotDispatchedError(
    err instanceof Error ? err.message : String(err),
    err,
  );
}

/** Runs `fn` against an initialized client for `endpoint`, using the account's credentials. */
export async function withClient<T>(
  env: ConnectionEnv,
  account: ConnectionAccount,
  endpoint: string,
  fn: (client: McpClient) => Promise<T>,
  options: WithClientOptions = {},
): Promise<T> {
  // Read once for the whole operation. The account refreshes a token a minute before expiry, so one
  // valid here stays valid for the handful of requests a single `withClient` makes.
  let connection: McpConnection;
  try {
    connection = await account.getConnection(endpoint);
  } catch (err) {
    throw notDispatched(err);
  }
  const { authorization, sessionId, generation } = connection;
  const client = new McpClient(
    endpoint, async method => {
      if (method === "tools/call") {
        await account.assertConnectionCurrent(endpoint, generation);
      }
      return authorization;
    }, sessionId, fetchOptions(env));
  let persistedSessionId = sessionId;

  const persistSession = async (): Promise<void> => {
    if (client.sessionId === persistedSessionId) return;
    const accepted = await account.setMcpSessionId(
      endpoint, generation, persistedSessionId, client.sessionId);
    if (!accepted) {
      await client.closeSession().catch(() => undefined);
      throw new McpCallNotDispatchedError(
        "Another request replaced this MCP transport session. Try again.");
    }
    persistedSessionId = client.sessionId;
  };

  const initialize = async (): Promise<void> => {
    await client.initialize(clientName(env));
    await persistSession();
  };

  const rejectCredentials = async (err: McpAuthRequiredError): Promise<never> => {
    const rejected = new Error(
      "The MCP server rejected this connection's credentials. Please reconnect the account.",
      { cause: err });
    let cause: unknown = rejected;
    try {
      await account.noteCredentialsExpired(endpoint, generation);
    } catch (notificationError) {
      cause = new AggregateError(
        [rejected, notificationError],
        "The credentials were rejected and their expiry notification failed.",
      );
    }
    throw new McpCallNotDispatchedError(rejected.message, cause);
  };

  try {
    if (!sessionId) {
      try {
        await initialize();
      } catch (err) {
        // Let the outer handler record credential rejection. Every other initialization failure is
        // known to precede the requested tool call.
        if (err instanceof McpAuthRequiredError) throw err;
        throw notDispatched(err);
      }
    }
    try {
      return await fn(client);
    } catch (err) {
      if (!(err instanceof McpSessionExpiredError)) throw err;
      if (options.retryOnExpiry !== false) {
        client.sessionId = null;
        try {
          await initialize();
        } catch (initializeError) {
          if (initializeError instanceof McpAuthRequiredError) throw initializeError;
          throw notDispatched(initializeError);
        }
        return await fn(client);
      }
      // This call is not retried, since it may already have taken effect. The session is gone all
      // the same, so the cached id is dead: left in place it would fail every later call for a
      // reason already known, including the retry the Workshop offers the user. Clearing it makes
      // the next call re-initialize.
      if (persistedSessionId) {
        await account.setMcpSessionId(endpoint, generation, persistedSessionId, null);
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof McpAuthRequiredError) {
      return rejectCredentials(err);
    }
    throw err;
  }
}

/**
 * Lists an endpoint's tools, bounded by `MAX_TOOLS_PER_SERVER`. Reports whether a cap cut the
 * listing short, since callers infer what the endpoint is from what it does and does not offer.
 */
export async function fetchTools(
  env: ConnectionEnv, account: ConnectionAccount, endpoint: string,
): Promise<ToolCatalog> {
  return withClient(env, account, endpoint,
    client => client.listTools(MAX_TOOLS_PER_SERVER));
}
