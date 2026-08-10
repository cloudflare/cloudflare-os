# Upstream ports

Append-only ledger of what we took from
[`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os) and what we deliberately
did not. Process: [`upstream-sync.md`](./upstream-sync.md).

**Triaged through: `1cb5e3d` (fork point) — nothing triaged yet.**

Update that mark on every pass. It cannot be derived: cherry-picking does not create ancestry, so
`merge-base` stays at the fork point forever and would keep re-offering commits already ported.

| upstream sha | date | verdict | why |
|---|---|---|---|
| `b2a51b5` | 2026-08-09 | **TO PORT** | RPC error classification. Rule 3 (auth) + rule 4 (touches `user.ts`, `server.ts`, `api.ts`). Also fixes a defect of ours — see below. |

## Pending: `b2a51b5`

Recommended as the first exercise of this process, because it is small, real, and fixes something
we broke.

**It repairs our own session-expiry work.** `user.ts:328` throws `new Error("invalid session
token")` for *both* a bogus token and an expired session, because we routed expiry through
`checkSession()`. `server.ts:736` throws a differently-capitalised `"Invalid session token."`. So a
client cannot distinguish "expired, log in again" from "bad token, something is wrong" — and
upstream's new classifier keys on exactly this. Upstream independently built the coded errors that
make it distinguishable; porting is cheaper than designing our own, which is the whole argument for
soft-forking.

Measured cost of the port (dry-run): **3 conflict hunks** — two import lines and one four-line throw
site. `workshop-shared/src/api.ts` auto-merges cleanly despite our `+42/−5`, and all 14 frontend
files apply with zero conflicts.

Resolution: keep our expiry-aware `checkSession()`, adopt upstream's coded error.
