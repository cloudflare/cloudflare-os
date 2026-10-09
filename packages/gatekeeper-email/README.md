# Gatekeeper Email

This package provides an email receiving gatekeeper for Gadgets. It allows a Gadget to receive inbound emails at an address like `<name>@<host>` via a hook.

Unlike most gatekeepers which connect to external services, this gatekeeper *is* the service -- it implements a Cloudflare Email Worker that receives mail directly.

## How It Works

The email gatekeeper uses the URL scheme `http://localhost:8787/gatekeeper/email/mailbox/<name>` to represent the email address `<name>@<host>`, where `<host>` is the domain configured to route email to this worker.

When a Gadget is connected to an email address:

1. The Gadget's code exports a `WorkerEntrypoint` that implements the `EmailHook` interface.
2. The coding agent calls `setBindingHook` to connect the hook to the binding.
3. The gatekeeper stores the hook reference in a Durable Object keyed by the email username.
4. When an email arrives, the Email Worker routes it to the appropriate DO, which invokes the Gadget's hook with the parsed email content.

Emails are parsed using [postal-mime](https://www.npmjs.com/package/postal-mime), so the hook receives structured data (from, to, subject, text body, HTML body, attachments) rather than raw MIME.

## Creating a Binding

1. Start the dev server (see root README).
2. Create or open a Gadget.
3. Navigate to the **Connections** tab.
4. Click **+ New Connection**.
5. Choose **Email Mailbox**.
6. Enter the mailbox local part, e.g. `myinbox`.
7. This represents the email address `myinbox@<host>`.
8. The binding will appear as `EMAIL` (the suggested name).

Mailbox names are canonicalized to lowercase. They may contain letters, numbers, dots, underscores, plus signs, or hyphens, and cannot start or end with a dot or contain consecutive dots.

The binding provides an `EmailSession` interface with a single method:

```typescript
interface EmailSession {
  getAddress(): Promise<string>;  // e.g. "myinbox@example.com"
}
```

To actually receive emails, the Gadget must implement a hook. Ask the coding agent to set up a hook for the email binding, or do it manually:

```typescript
// In the Gadget's code:
import { WorkerEntrypoint } from "cloudflare:workers";

export class MyEmailHandler extends WorkerEntrypoint {
  async receiveEmail(email) {
    // email has: from, to, cc, subject, date, text, html, attachments
    console.log(`Got email from ${email.from.address}: ${email.subject}`);
    // Store it, process it, etc.
  }
}
```

Then prompt your coding agent to use the `setBindingHook` tool to connect it:
- Binding: `EMAIL`
- Export name: `MyEmailHandler`

## Local Development

In local development, the gatekeeper is served under the path `/gatekeeper/email` on `localhost:8787`. We don't actually support receiving real SMTP email locally.

### Sending a Test Email

In local dev, wrangler exposes a `/cdn-cgi/handler/email` endpoint that simulates inbound email. You can POST raw email content to it using curl.

With the dev server running (`pnpm run dev-server` from the repo root), send a test email:

```bash
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=myinbox@example.com' \
  --header 'Content-Type: application/json' \
  --data-raw 'From: "Alice" <sender@example.com>
To: myinbox@example.com
Subject: Hello from local dev
Content-Type: text/plain; charset="utf-8"
Date: Mon, 16 Feb 2026 12:00:00 +0000
Message-ID: <test-123@example.com>

This is a test email body.'
```

The `to` address's local part (`myinbox`) determines which `EmailAddress` Durable Object receives the email. Make sure:
- You have a Gadget with an Email Mailbox binding for `myinbox@<host>`
- The binding has a hook connected via `setBindingHook`

If no hook is configured for that address, the email will be rejected.

## Production Configuration

In production, you need to set up [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/) to forward emails to this worker.

### Step 1: Deploy the email gatekeeper and set env.BASE_URL

Set the `BASE_URL` environment variable to the full base URL (protocol + host + optional path) at which the email gatekeeper's fetch handler is served. No trailing slash. For example:

```
# Deployed as its own worker at the root:
BASE_URL=https://gatekeeper-email.example.workers.dev

# Or co-hosted on the same domain as the main app under a path:
BASE_URL=https://app.example.com/gatekeeper/email
```

All occurrences of `http://localhost:8787/gatekeeper/email` in the doc above will in production be replaced by this `BASE_URL` value.

### Step 2: Enable Email Routing

1. In the Cloudflare dashboard, go to your domain's **Email Routing** settings.
2. Follow the setup wizard to enable Email Routing and configure the required DNS records (MX, SPF, etc.).

### Step 3: Create an Email Worker Route

1. Go to **Email Routing** > **Email Workers**.
2. Create a route that matches the addresses you want to handle. For example:
   - **Custom address**: `*@yourdomain.com` (catch-all) or specific addresses like `gadget-*@yourdomain.com`
   - **Action**: Send to a Worker
   - **Worker**: Select the deployed `gatekeeper-email` worker
3. Alternatively, you can configure this in your Worker config for deployment.

### How It Fits Together

```
Internet email → Cloudflare Email Routing → gatekeeper-email worker
                                               │
                                               ├── email() handler parses recipient
                                               │
                                               ▼
                                          EmailAddress DO (per username)
                                               │
                                               ├── loads stored hook Fetcher
                                               │
                                               ▼
                                          Gadget's hook entrypoint
                                          (via Overseer loopback)
```

Each email address maps to a Durable Object named by its local part. The DO stores the hook `Fetcher` in KV storage, which persists across requests. When an email arrives, the DO loads the hook and calls `receiveEmail()` with the parsed email data.
