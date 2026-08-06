# seat-proxy

Lets a user reach an AI provider (Anthropic, OpenAI) through their own existing
subscription seat, without handing that provider's real access/refresh tokens to
anything outside this host. Cloudflare OS talks to this service the same way it
talks to any OpenAI/Anthropic-compatible endpoint — the only difference is the
"API token" it sends is an opaque **handle**, not a real provider credential.

**Enrollment is driven entirely over HTTP now.** The provider CLIs
(`claude`, `codex`) are no longer required on the host, and nobody needs shell
access to this machine to enrol — seat-proxy drives the OAuth exchange itself.

## How it works

1. A caller starts enrollment for a user and provider. seat-proxy either hands
   back a URL for the user to open and approve (Anthropic), or a short code
   plus a verification page (OpenAI) — see [Enrolling a seat](#enrolling-a-seat)
   below.
2. Once the user approves, the caller completes enrollment. seat-proxy exchanges
   the authorization for real tokens, writes them to a private per-owner
   directory, and mints a random handle bound to `(owner, provider, that
   directory)`. The handle is stored in a local SQLite database — the
   *directory path*, not the tokens themselves.
3. When a request comes in carrying that handle, seat-proxy reads the current
   tokens from disk, refreshes them if they're near expiry, and relays the
   request upstream with the real access token attached. Tokens never leave the
   process; only the handle is ever handed to a caller.

## Requirements

Python 3.13. No virtualenv is required to run tests or the service itself —
just make the dependencies in `requirements.txt` available on your `python`:

```
cd seat-proxy
pip install -r requirements.txt
```

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

Enrollment is a start/complete flow. `start` kicks off an OAuth authorization
with the provider; `complete` exchanges what the user got back for real
tokens. The shape of both steps differs by provider, because Anthropic and
OpenAI use different OAuth grants.

Owner names (the `X-Seat-Owner` header) must be **lowercase**, and are
restricted to `[A-Za-z0-9._@-]` — no path separators, no leading or trailing
dot, and no reserved device names (`con`, `prn`, `aux`, `nul`, `com1`-`com9`,
`lpt1`-`lpt9`). A mixed-case or otherwise invalid owner gets a plain 400 with
no further detail, so get the casing right before debugging anything else.

### Anthropic

1. **Start:**

   ```
   curl -s -X POST localhost:8890/enroll/anthropic/start -H "X-Seat-Owner: alice"
   ```

   ```json
   {"enroll_id": "<enroll_id>", "kind": "authorize_url", "url": "https://claude.com/cai/oauth/authorize?..."}
   ```

   Send the user to `url`. They'll see a consent screen — **it names "Claude
   Code"**, not seat-proxy or Cloudflare OS, because this flow uses Claude
   Code's public OAuth client. Tell the user in advance what they're approving;
   the screen itself won't say "seat-proxy" anywhere. After they approve,
   Anthropic shows them a short code to copy back.

2. **Complete**, with that code:

   ```
   curl -s -X POST localhost:8890/enroll/anthropic/complete \
     -H "content-type: application/json" \
     -d '{"enroll_id":"<enroll_id>","code":"<code from the consent screen>"}'
   ```

   ```json
   {"status": "complete", "handle": "<handle>", "models": [...]}
   ```

### OpenAI

1. **Start:**

   ```
   curl -s -X POST localhost:8890/enroll/openai/start -H "X-Seat-Owner: alice"
   ```

   ```json
   {"enroll_id": "<enroll_id>", "kind": "device_code",
    "user_code": "ABCD-1234", "verification_uri": "https://...", "interval": 5}
   ```

   Send the user to `verification_uri` and have them enter `user_code`.

2. **Complete** — poll with just the `enroll_id` (no `code`) at roughly
   `interval` seconds until it stops returning `{"status": "pending"}`:

   ```
   curl -s -X POST localhost:8890/enroll/openai/complete \
     -H "content-type: application/json" -d '{"enroll_id":"<enroll_id>"}'
   ```

   ```json
   {"status": "complete", "handle": "<handle>", "models": [...]}
   ```

In both cases, the `handle` from a `"complete"` response is what you give to
whatever is going to use this seat. Treat it like a bearer credential — anyone
holding it can relay requests as that user's subscription seat until it's
revoked.

### Checking available models later

```
curl -s "localhost:8890/enroll/anthropic/models?handle=<handle>"
```

```json
{"models": [...]}
```

## Wiring a handle into Cloudflare OS

In the running Cloudflare OS instance: **Add Model → Advanced Settings → API
URL**, set the API URL to `http://localhost:8890/anthropic` (or `/openai`),
and paste the handle from the `complete` response into the API token field.
No fork changes are required — this works because seat-proxy speaks the same
wire protocol as the real provider API.

## Revoking a seat

```
curl -s -X DELETE localhost:8890/enroll/<handle> -H "X-Seat-Owner: alice"
```

The owner must match the handle's enrolled owner. This deletes the handle from
the database; it does **not** delete the on-disk credentials, but re-enrolling
the same owner and provider always runs fresh OAuth — `complete` overwrites
`state/<owner>/<provider>` with the newly obtained tokens, and mints a new
handle that revokes the previous one.

## Security properties — read before deploying

**This service binds to loopback only and has no authentication beyond the
handle.** `/enroll/*/start` trusts the `X-Seat-Owner` header completely —
whoever can reach that endpoint can enroll (and later relay requests) as any
owner name they choose. There is no login, API key, or session check in front
of it. **Never expose this service to a network.** Only the Cloudflare OS
backend running on the same host should be able to reach `127.0.0.1:8890`.

**Each user's tokens live in `state/<owner>/<provider>/`, created by seat-proxy
itself on enrollment.** On POSIX, that directory is created at mode `0700`; on
Windows `os.chmod` is a near no-op and its failure is silently swallowed, so
the mode is not actually enforced there. seat-proxy writes the tokens there once
when `complete` succeeds, then reads them from that file on each subsequent
request rather than holding a copy in memory. On a shared host, the `0700`
permission is what is supposed to keep one user's subscription credentials
from being readable by another user. That guarantee only holds if each user's
directory is actually read by a process running as that user. Today it isn't:
seat-proxy is a single process, so as long as it runs as one OS user, that
process can read every enrolled user's directory regardless of the `0700`
bit. Splitting seat-proxy into one worker process per user, running as that
user's own OS account, is the planned fix and is deferred until scale
justifies it — `config_dir` on each store record is already the seam that
split would use.

## Tests

```
cd seat-proxy
python -m pytest -q
```
