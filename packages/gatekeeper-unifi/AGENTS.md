# UniFi gatekeeper

UniFi Network and Protect in one gatekeeper, reached through Site Manager's Cloud Connector (a Site
Manager API key: owned consoles only, UniFi OS 5.0.3+, 100 requests a minute per console, no
WebSockets) or directly at a console (its own API key, optionally behind Cloudflare Access). The
README covers both, including the TLS options for a console's self-signed certificate.

- Its workerd tests hit a trap gatekeeper-gitlab's did too: under the capnweb-validate vite plugin,
  decorated `WorkerEntrypoint`s aren't registered in `ctx.exports`, so `__tests__/worker.ts` exports
  undecorated subclasses under the production names.
