// Property: one account's credentials under the scheduling real usage produces. Two chats share a
// connection to a provider whose refresh tokens are single-use (GitLab, X) while its access token
// expires or is dropped early, the user reconnects or disconnects, and the provider revokes the
// grant. fast-check generates those steps in order, and its scheduler decides when each provider
// response, account reply and Workshop notification lands between them.
//
// Losing one rotation locks the account until the user reconnects, and replaying a write after a
// reconnect performs it as whoever reconnected. So, whatever the schedule:
//  - an operation runs at most twice, once unless replayable, and never under two connections;
//  - what is stored is the last grant connected, or nothing after a disconnect;
//  - each token pair the provider minted went exactly one way: it was stored, or handed to
//    `discardMint`, or refused by `connect()` because a later reconnect or disconnect won;
//  - afterwards each chat can run an operation exactly when the account is still connected to a
//    grant the provider has not revoked.
// The oracles are the test's own: each operation records the tokens it was called with, the
// provider maps every token it minted to its grant, and storage records what was written to it.
// Every run builds a fresh provider, account and chats, so runs and shrinks are independent, and
// the workflows a seed might miss are pinned as `examples`, each under a few fixed schedules.

import * as fc from "fast-check";
import { expect, it, vi } from "vitest";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import {
  ConnectionSupersededError, CredentialCoordinator, CredentialsExpiredError, CredentialSource,
  isCredentialsChanged, isCredentialsExpired,
} from "../src/credentials";
import { fakeKv } from "./fake-kv";

type Creds = { access: string; refresh: string; expiresAt: number };
type Step =
  | { kind: "run"; chat: 0 | 1; replayable: boolean }
  | { kind: "expire" | "staleBearer" | "reconnect" | "revoke" | "disconnect" };

/**
 * A provider with expiring access tokens and single-use refresh tokens. Each connect flow
 * authorizes a new grant, and only a grant's newest access token is accepted: GitLab invalidates
 * one when it issues the next. Time is the model's own, since fast-check's time limit reads the
 * real clock.
 */
function rotatingProvider() {
  const minted: (Creds & { grant: number })[] = [];
  let [now, grants, revokedBelow, staleBelow] = [0, 0, 0, 0];
  const mint = (grant: number): Creds => {
    const serial = minted.length;
    const creds = { access: `access${serial}`, refresh: `refresh${serial}`, expiresAt: now + 1 };
    minted.push({ ...creds, grant });
    return creds;
  };
  const newest = (grant: number) => minted.findLast(pair => pair.grant === grant);
  const live = (grant: number) => grant >= revokedBelow;
  return {
    /** Every token pair issued, in order. */
    minted,
    now: () => now,
    grantOf: (access: string) => minted.find(pair => pair.access === access)?.grant,
    live,
    authorize: () => mint(grants++),
    refresh(current: Creds): Creds {
      const used = minted.find(pair => pair.refresh === current.refresh);
      if (used === undefined || !live(used.grant) || used !== newest(used.grant)) {
        throw new CredentialsExpiredError("invalid_grant");
      }
      return mint(used.grant);
    },
    accepts(access: string): boolean {
      const serial = minted.findIndex(pair => pair.access === access);
      const used = minted[serial];
      return used !== undefined && live(used.grant) && used === newest(used.grant)
        && serial >= staleBelow && used.expiresAt > now;
    },
    expire: () => void now++,
    /** Drops every access token early; their refresh tokens still work. */
    dropAccessTokens: () => void (staleBelow = minted.length),
    /** The user revokes the app at the provider, ending every grant made so far. */
    revoke: () => void (revokedBelow = grants),
  };
}

/** How often the schedules reached the races the property is about. */
const reached = { reconnectMidRefresh: 0, discardedMint: 0, secondAttempt: 0 };

async function replay(steps: Step[], s: fc.Scheduler): Promise<void> {
  const provider = rotatingProvider();
  // Everything that crosses a network waits here for the scheduler to let it land.
  const hop = (label: string) => s.schedule(Promise.resolve(), label);
  // What became of each mint, by access token.
  const [written, discarded, refused] = [0, 1, 2].map(() => new Set<unknown>());
  const kv = fakeKv();
  const coordinator = new CredentialCoordinator<Creds>({
    ...kv,
    put: (key, value) => {
      if (typeof value === "object" && value !== null && "access" in value) {
        written.add(value.access);
      }
      kv.put(key, value);
    },
  }, {
    expiresAt: creds => creds.expiresAt > provider.now() ? Number.MAX_SAFE_INTEGER : 0,
    discardMint: async mint => {
      discarded.add(mint.access);
      await hop("discardMint");
    },
  });

  let refreshing = 0;
  const refresh = async (current: Creds): Promise<Creds> => {
    refreshing++;
    try {
      await hop(`refresh with ${current.refresh}`);
      return provider.refresh(current);
    } finally {
      // The provider has rotated by now, whatever happens to the account before its answer lands.
      await hop("refresh answered");
      refreshing--;
    }
  };
  const notify = () => hop("notify");
  // The account answers at once and the reply arrives later, so a chat can act on a read the
  // account has since moved past.
  const reply = async <T>(label: string, answer: Promise<T>): Promise<T> => {
    try {
      return await answer;
    } finally {
      await hop(label);
    }
  };
  const account = {
    getCredentials: () => reply("getCredentials", coordinator.snapshot(refresh, { notify })),
    reportCredentialsRejected: (identity: string) => reply("reportCredentialsRejected",
      coordinator.adjudicateRejection(identity, { refresh, notify })),
  };
  const chats = [0, 1].map(() => new CredentialSource<Creds>({
    account: () => account,
    isAuthError: error => error instanceof Error && error.message === "401",
    expiredMessage: "Reconnect.",
  }));

  const runs: { replayable: boolean; attempts: string[] }[] = [];
  /** @returns Whether the operation succeeded, the chat otherwise told to re-enter or reconnect. */
  const run = (chat: number, replayable: boolean): Promise<boolean> => {
    const attempts: string[] = [];
    runs.push({ replayable, attempts });
    return chats[chat].run(async creds => {
      attempts.push(creds.access);
      await hop(`chat ${chat} calls with ${creds.access}`);
      if (!provider.accepts(creds.access)) throw new Error("401");
    }, { replayable }).then(() => true, error => {
      if (!isCredentialsChanged(error) && !isCredentialsExpired(error)) throw error;
      return false;
    });
  };

  // The test's own record of the connection: the grant connected, and a count of connects and
  // disconnects that tells a reconnect whether another one overtook it.
  let connected: number | undefined = 0;
  let epoch = 0;
  coordinator.connect(provider.authorize());
  const reconnect = async () => {
    const [startedUnder, startedAt] = [coordinator.connectionGeneration(), epoch];
    await hop("authorize");
    const creds = provider.authorize();
    const connect = () => coordinator.connect(creds, { ifGeneration: startedUnder });
    if (epoch !== startedAt) {
      expect(connect).toThrow(ConnectionSupersededError);
      refused.add(creds.access);
      return;
    }
    if (refreshing > 0) reached.reconnectMidRefresh++;
    connect();
    connected = provider.grantOf(creds.access);
    epoch++;
  };

  const inFlight: Promise<unknown>[] = [];
  const timeline = (async () => {
    for (const [at, step] of steps.entries()) {
      await hop(`step ${at}: ${step.kind}`);
      if (step.kind === "run") inFlight.push(run(step.chat, step.replayable));
      else if (step.kind === "reconnect") inFlight.push(reconnect());
      else if (step.kind === "expire") provider.expire();
      else if (step.kind === "staleBearer") provider.dropAccessTokens();
      else if (step.kind === "revoke") provider.revoke();
      else {  // disconnect
        coordinator.clear();
        connected = undefined;
        epoch++;
      }
    }
    await Promise.all(inFlight);
  })();
  await s.waitFor(timeline);

  // With the access token expired, each chat's next operation has to refresh with what is stored.
  provider.expire();
  const healthy = connected !== undefined && provider.live(connected);
  for (const chat of [0, 1]) {
    expect(await s.waitFor(run(chat, false)), `chat ${chat} runs afterwards`).toBe(healthy);
  }

  for (const { replayable, attempts } of runs) {
    expect(attempts.length, "times one operation ran").toBeLessThanOrEqual(replayable ? 2 : 1);
    expect(new Set(attempts.map(provider.grantOf)).size, "grants one operation ran under")
      .toBeLessThanOrEqual(1);
  }
  const stored = coordinator.stored();
  expect(stored && provider.grantOf(stored.access), "the stored grant").toBe(connected);
  for (const { access } of provider.minted) {
    const fates = [written, discarded, refused].filter(tokens => tokens.has(access));
    expect(fates, `fates of ${access}`).toHaveLength(1);
  }

  reached.discardedMint += discarded.size;
  reached.secondAttempt += runs.filter(({ attempts }) => attempts.length === 2).length;
}

const on = (kind: Exclude<Step["kind"], "run">): Step => ({ kind });
const operation = (chat: 0 | 1, replayable: boolean): Step => ({ kind: "run", chat, replayable });
// Operations outweigh the rest: the races need some in flight when the connection changes.
const chat = fc.constantFrom<0 | 1>(0, 1);
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.tuple(chat, fc.boolean()).map(args => operation(...args)) },
  { weight: 3, arbitrary: fc.constant(on("expire")) },
  { weight: 2, arbitrary: fc.constant(on("staleBearer")) },
  { weight: 2, arbitrary: fc.constant(on("reconnect")) },
  { weight: 1, arbitrary: fc.constant(on("revoke")) },
  { weight: 1, arbitrary: fc.constant(on("disconnect")) },
);

// A read may be replayed; a write may not.
const read = (chat: 0 | 1) => operation(chat, true);
const write = (chat: 0 | 1) => operation(chat, false);
const workflows: Step[][] = [
  // The access token expires under both chats and the user reconnects while it refreshes.
  [on("expire"), write(0), read(1), on("reconnect"), read(0), write(1)],
  // The provider drops the access token early: both chats' calls are refused and have to heal.
  [write(0), on("staleBearer"), read(0), read(1), write(1), write(0)],
  // The user revokes the app at the provider, is told to reconnect, and does.
  [read(0), on("revoke"), read(0), write(1), on("reconnect"), read(1), write(0)],
  // The user disconnects during a refresh, then connects again.
  [on("expire"), read(0), write(1), on("disconnect"), read(1), on("reconnect"), write(0)],
];

it("never replays an operation across connections or loses a token rotation", async () => {
  const examples = workflows.flatMap(steps => fc.sample(fc.scheduler(), { seed: 0, numRuns: 10 })
    .map((schedule): [Step[], fc.Scheduler] => [steps, schedule]));
  // The kit logs each heal a reconnect or disconnect overtook, hundreds of lines over the runs.
  const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), fc.scheduler(), replay),
      { ...PROPERTY_RUN_OPTIONS, numRuns: 1000, examples });
  } finally {
    logged.mockRestore();
  }
  // A schedule property that never reaches its races proves little.
  expect(Object.entries(reached).filter(([, times]) => times === 0)).toEqual([]);
}, 120_000);
