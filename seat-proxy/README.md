# seat-proxy

Lets a user reach an AI provider (Anthropic, OpenAI) through their own existing
subscription seat, without handing that provider's real access/refresh tokens to
anything outside the machine the CLI logged in on. Cloudflare OS talks to this
service the same way it talks to any OpenAI/Anthropic-compatible endpoint — the
only difference is the "API token" it sends is an opaque **handle**, not a real
provider credential.

## How it works

1. A user runs the provider's own CLI login (`claude login`, `codex login`, ...),
   pointed at a private directory this service manages.
2. seat-proxy notices the login completed, reads the credentials file the CLI
   wrote, and mints a random handle bound to `(owner, provider, that directory)`.
   The handle is stored in a local SQLite database — the *directory path*, not
   the tokens themselves.
3. When a request comes in carrying that handle, seat-proxy reads the current
   tokens from disk, refreshes them if they're near expiry, and relays the
   request upstream with the real access token attached. Tokens never leave the
   process; only the handle is ever handed to a caller.

## Requirements

Python 3.13. No virtualenv is required to run tests or the service itself —
just make the dependencies in `requirements.txt` available on your `python`.

## Environment variables

| Variable            | Default     | Meaning                                                          |
|----------------------|-------------|-------------------------------------------------------------------|
| `SEAT_PROXY_STATE`  | `state`     | Root directory for per-user provider config dirs (see below).    |
| `SEAT_PROXY_DB`     | `seats.db`  | SQLite file mapping handles to `(owner, provider, config_dir)`.  |
| `SEAT_PROXY_PORT`   | `8890`      | Loopback port the service listens on.                            |

## Running

```
cd seat-proxy
python main.py
```

This starts the service on `http://127.0.0.1:8890` (or `SEAT_PROXY_PORT`).

## Enrolling a seat

Enrollment is a two-step start/poll flow, because the middle step is a CLI
login the user completes interactively in another terminal.

1. **Start** — tell seat-proxy who is enrolling and for which provider:

   ```
   curl -s -X POST localhost:8890/enroll/anthropic/start -H "X-Seat-Owner: alice"
   ```

   The response includes a `poll_id` and a `command` — something like
   `CLAUDE_CONFIG_DIR="state/alice/anthropic" claude login`. Run that command
   yourself (or have the user run it) and complete the provider's normal login
   flow in a browser.

2. **Poll** — once the login has finished, ask seat-proxy to pick up the result:

   ```
   curl -s -X POST localhost:8890/enroll/anthropic/poll \
     -H "content-type: application/json" -d '{"poll_id":"<poll_id from start>"}'
   ```

   While the CLI login is still in progress this returns `{"status":"pending"}`
   — poll again after a moment. Once the CLI has written its credentials file,
   it returns:

   ```
   {"status":"complete","handle":"<handle>","models":[...]}
   ```

   The `handle` is what you give to whatever is going to use this seat. Treat
   it like a bearer credential — anyone holding it can relay requests as that
   user's subscription seat until it's revoked.

## Wiring a handle into Cloudflare OS

In the running Cloudflare OS instance: **AI Providers → Add model → (Anthropic
or OpenAI) → Advanced Settings → API URL**, set the API URL to
`http://localhost:8890/anthropic` (or `/openai`), and set the API token field to
the handle from the poll response. No fork changes are required — this works
because seat-proxy speaks the same wire protocol as the real provider API.

## Revoking a seat

```
curl -s -X DELETE localhost:8890/enroll/<handle> -H "X-Seat-Owner: alice"
```

The owner must match the handle's enrolled owner. This deletes the handle from
the database; it does **not** delete the on-disk credentials, so the same owner
can re-enroll the same provider without logging in again (the next `start` call
reuses `state/<owner>/<provider>`).

## Security properties — read before deploying

**This service binds to loopback only and has no authentication beyond the
handle.** `/enroll/*/start` trusts the `X-Seat-Owner` header completely —
whoever can reach that endpoint can enroll (and later relay requests) as any
owner name they choose. There is no login, API key, or session check in front
of it. **Never expose this service to a network.** Only the Cloudflare OS
backend running on the same host should be able to reach `127.0.0.1:8890`.

**Each user's tokens live in `state/<owner>/<provider>/`, a directory owned and
written by that provider's own CLI, created `0700`.** seat-proxy itself never
holds a copy of the tokens — it reads them from that file on each request. On a
shared host, the `0700` permission is what is supposed to keep one user's
subscription credentials from being readable by another user. That guarantee
only holds if each user's directory is actually read by a process running as
that user. Today it isn't: seat-proxy is a single process, so as long as it
runs as one OS user, that process can read every enrolled user's directory
regardless of the `0700` bit. Splitting seat-proxy into one worker process per
user, running as that user's own OS account, is the planned fix and is
deferred until scale justifies it — `config_dir` on each store record is
already the seam that split would use.

## Tests

```
cd seat-proxy
python -m pytest -q
```
