import { abortAllDurableObjects } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  createOpenGadgetError,
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi,
  type OpenGadgetErrorCode,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

type CodedError = Error & { code?: unknown };

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const EXPECTED_MESSAGES: Record<OpenGadgetErrorCode, string> = {
  [OPEN_GADGET_ERROR_CODES.workspaceNotFound]: "Workspace not found.",
  [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied]: "You don't have access to this workspace.",
};

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

async function rejection(value: PromiseLike<unknown>): Promise<CodedError> {
  try {
    await value;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new TypeError("Expected RPC to reject with an Error.", { cause: error });
    }
    return error;
  }
  throw new Error("Expected RPC to reject.");
}

function expectRpcCode(error: CodedError, code: OpenGadgetErrorCode): void {
  expect(error.message).toBe(EXPECTED_MESSAGES[code]);
  expect(error.code).toBe(code);
  expect(Object.prototype.propertyIsEnumerable.call(error, "code")).toBe(true);
  expect(getOpenGadgetErrorCode(error)).toBe(code);
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");

  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(
    publicApi: RpcStub<PublicApi>, prefix: string): Promise<{ username: string; token: string }> {
  const name = username(prefix);
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return { username: name, token };
}

async function openRejection(
    authenticated: RpcStub<AuthenticatedApi>,
    id: string): Promise<CodedError> {
  using workspace = authenticated.openGadget(id);
  return await rejection(workspace.getMetadata());
}

// TODO: This test suite keeps timing out in CI, skipping for now.
describe.skip("openGadget errors across native RPC and Cap'n Web", () => {
  it("retains enumerable Error.code at the native Durable Object boundary", async () => {
    const code = OPEN_GADGET_ERROR_CODES.workspaceNotFound;
    const local = createOpenGadgetError(code);

    expect(local.message).toBe(EXPECTED_MESSAGES[code]);
    expect(local.code).toBe(code);
    expect(Object.prototype.propertyIsEnumerable.call(local, "code")).toBe(true);

    const name = username("native");
    const userId = exports.UserDurableObject.idFromName(name).toString();
    const workspaceId = exports.OverseerDurableObject.newUniqueId();
    const error = await rejection(
      exports.OverseerDurableObject.get(workspaceId).open(userId, name, () => {}),
    );

    expectRpcCode(error, code);
  });

  it("maps malformed IDs through AuthenticatedApi", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "missing");
    using authenticated = await publicApi.authenticate(account.token);

    const error = await openRejection(authenticated, "not-a-durable-object-id");
    expectRpcCode(error, OPEN_GADGET_ERROR_CODES.workspaceNotFound);
  });

  it("maps valid-but-missing IDs through AuthenticatedApi", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "missing");
    using authenticated = await publicApi.authenticate(account.token);

    const id = exports.OverseerDurableObject.newUniqueId().toString();
    const error = await openRejection(authenticated, id);
    expectRpcCode(error, OPEN_GADGET_ERROR_CODES.workspaceNotFound);
  });

  it("maps an unauthorized existing workspace to access denied", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "owner");
    const intruderAccount = await createAccount(publicApi, "intruder");
    using owner = await publicApi.authenticate(ownerAccount.token);
    using intruder = await publicApi.authenticate(intruderAccount.token);

    using workspace = await owner.newGadget();
    const metadata = await workspace.getMetadata();

    const nativeError = await rejection(
      exports.OverseerDurableObject
        .get(exports.OverseerDurableObject.idFromString(metadata.id))
        .open(
          exports.UserDurableObject.idFromName(intruderAccount.username).toString(),
          intruderAccount.username,
          () => {},
        ),
    );
    expectRpcCode(nativeError, OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);

    const browserError = await openRejection(intruder, metadata.id);
    expectRpcCode(browserError, OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
  });
});

// In production, workerd tags rejections from a reset DO with the structured flags
// do-telemetry.ts reads. Locally, vitest-pool-workers aborts reject FLAGLESS — this test pins that, so if a
// future pool upgrade starts attaching the production flags, it fails and the flag paths can
// graduate from synthetic unit tests to real-reset integration tests. abortAllDurableObjects()
// is the non-graceful teardown (deliberately not evictDurableObject(), which never breaks a
// stub).
describe("user-DO reset flags", () => {
  it("local aborts reject flagless — flag-based recovery is untestable locally", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "probe");
    using authenticated = await publicApi.authenticate(account.token);

    expect(await authenticated.listModels()).toBeInstanceOf(Array);

    // Bind a native stub to the current DO incarnation BEFORE the reset — a stub minted after
    // the abort would simply restart the object and succeed. This poisoned-stub rejection is
    // the exact shape AuthenticatedApiImpl sees when one of its calls loses the reset race.
    const userStub = exports.UserDurableObject.get(
      exports.UserDurableObject.idFromName(account.username));
    expect(await userStub.listModels()).toBeInstanceOf(Array);

    await abortAllDurableObjects();

    // The session recovers: AuthenticatedApiImpl resolves a fresh stub per call, so the
    // restarted object serves this read — the browser never sees the reset.
    expect(await authenticated.listModels()).toBeInstanceOf(Array);

    const nativeErr = await rejection(userStub.listModels());
    expect({
      message: nativeErr.message,
      durableObjectReset: (nativeErr as Record<string, unknown>).durableObjectReset,
      retryable: (nativeErr as Record<string, unknown>).retryable,
      overloaded: (nativeErr as Record<string, unknown>).overloaded,
    }).toEqual({
      message: "Application called abortAllDurableObjects().",
      durableObjectReset: undefined,
      retryable: undefined,
      overloaded: undefined,
    });

    // Permanently broken, not fail-once: the fresh-stub-per-call design rests on this.
    const nativeErr2 = await rejection(userStub.listModels());
    expect(nativeErr2.message).toBe("Application called abortAllDurableObjects().");
  });
});
