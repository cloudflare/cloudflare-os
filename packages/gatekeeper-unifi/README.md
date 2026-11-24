# Gatekeeper UniFi

A gatekeeper for Ubiquiti's [UniFi](https://ui.com) **Network** and **Protect** applications. One
connection covers both, reached either through UniFi Site Manager's Cloud Connector or directly
at the console. Agents read devices, clients, WiFi networks, cameras, sensors, and floodlights, and
make changes through the approval queue: restarts, PoE port power-cycles, guest WiFi access and
vouchers, WiFi network settings, camera settings, PTZ moves, and floodlight control.

The agent-facing API is `src/network-types.d.ts` and `src/protect-types.d.ts`.

## Connecting

The connect page offers two forms. A reconnect stays in the mode it was made in.

### Through the cloud (Site Manager)

Paste a Site Manager API key, created at unifi.ui.com under Settings → API Keys. The gatekeeper
lists the account's consoles with it and proxies requests through the Cloud Connector.

- The console must run UniFi OS 5.0.3 or later.
- A key reaches only the consoles its account **owns**. Consoles the account administers are
  listed but the Cloud Connector refuses them; connect those directly instead.
- The Cloud Connector allows 100 requests a minute per console, answers within 25 seconds,
  returns at most 10 MB, and carries HTTP only: no WebSockets.
- Site Manager documents its API keys as read-only for now. If UniFi refuses a change made through
  the cloud, the approval reports it and reads keep working; connect the console directly to make
  changes.
- A reconnect must be the same UniFi account, by the email Site Manager reports. A key whose
  email Site Manager leaves out can't replace another; connect it as a new connection instead.

### Directly to a console

Give the console's URL and an API key created on the console in its Integrations settings. If
the console sits behind Cloudflare Access, add a service token's client ID and secret, which are
sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` with every request.

- The gatekeeper probes Network and Protect with the key, and learns the console's name and MAC
  addresses. The console is then known as `local-` plus 16 hex digits, which is kept across
  reconnects.
- The URL can't change on reconnect, and a reconnect must reach the same console, matched by MAC.
  A console that didn't report a MAC address when it connected can't be reconnected in place.
- `http://` URLs are accepted for loopback addresses only.
- **Reachability.** On a Cloudflare-hosted deployment, `global_fetch_strictly_public` means the
  console must be reachable at a public address; private and LAN addresses are refused. Use a
  Cloudflare Tunnel or a reverse proxy. Run locally (`wrangler dev`, or a self-hosted workerd),
  LAN addresses work.
- **TLS.** Workers always verify certificates and can't be told to skip it, and a console ships
  a self-signed certificate. Any one of these fixes it:
  1. Load a certificate from a trusted CA onto the console.
  2. Put a reverse proxy with a trusted certificate in front of the console.
  3. Publish the console through a Cloudflare Tunnel; `cloudflared` can accept the console's own
     certificate on its side (`noTLSVerify`). Protect the hostname with Cloudflare Access and
     give the form a service token.
  4. Running locally, set `NODE_EXTRA_CA_CERTS` to a file holding the console's certificate, and
     connect with a hostname that certificate names.

## Resources

| Resource | URL pattern | Grants |
| --- | --- | --- |
| Network site | `https://unifi.ui.com/consoles/:consoleId/network/sites/:siteId` | A site's devices, clients, networks, WiFi networks, and guest hotspot. |
| Device | `…/network/sites/:siteId/devices/:deviceId` | One gateway, switch, or access point. Add `?clients=1` to also grant the clients connected through it. |
| WiFi network | `…/network/sites/:siteId/wifi/:wifiNetworkId` | One SSID's settings and password. |
| Guest hotspot | `…/network/sites/:siteId/hotspot` | Guests and vouchers only; never a client that isn't a guest. |
| Protect | `https://unifi.ui.com/consoles/:consoleId/protect` | Every camera, sensor, and floodlight, and the alarm's state. |
| Camera | `…/protect/cameras/:cameraId` | One camera or doorbell: snapshots and settings. |
| Sensor | `…/protect/sensors/:sensorId` | One sensor's readings. |
| Floodlight | `…/protect/lights/:lightId` | One floodlight. |

The URLs are identifiers, not where requests go. `:consoleId` is the Site Manager host ID for a
cloud connection, and the `local-…` ID for a direct one. An agent may write `-` for an ID it
doesn't know, and the user chooses it in the resource picker.

## Approvals

Every read is recorded as an observation. Every change waits for approval:

| Change | Auto-approvable | The agent's call |
| --- | --- | --- |
| Restart a device | Yes | Waits for the decision |
| Restart the gateway (the network goes down) | Never | Waits for the decision |
| Power-cycle a PoE port | Yes | Waits for the decision |
| Let a guest use the WiFi, or revoke it | Never | Continues; reads show the change |
| Change a WiFi network's name, password, visibility, or whether it's on | Never | Continues; reads show the change |
| Create guest vouchers | Never | Waits for the decision, since codes exist only once created |
| Delete a voucher | Never | Continues; reads show the change |
| Rename a camera, or switch its status light | Yes | Continues; reads show the change |
| Show a message on a doorbell | Never | Continues; reads show the change |
| Set a camera's microphone volume | Never | Continues; reads show the change |
| Move a PTZ camera to a preset, or start or stop a patrol | Yes | Waits for the decision |
| Force a floodlight on, or change its mode or brightness | Yes | Continues; reads show the change |

Changes to WiFi and guest access are never auto-approvable because they change who can use the
network, and a doorbell message isn't because it's shown to whoever comes to the door. A device
the device list doesn't classify can't be restarted, since it can't be told apart from the
gateway. Approvals name what they change ("Restart “Living Room AP”"), as UniFi names it now rather than as
an earlier pending rename would, with its UniFi ID alongside. Action history is visible to
everyone the workspace is shared with, which is fine for names, but an approval never shows a WiFi
password or voucher code that still works: a new password is described as changing.

Nothing is reverted automatically. A change UniFi refuses, or whose target is gone, fails
without a retry. A restart, power-cycle, guest grant, or voucher batch interrupted after it was
sent is reported as having an unknown outcome and is never sent again. WiFi changes are written
one at a time per network, from a fresh read, across every connection in the deployment (two
people's keys to one console included), so changes approved at once all take effect. UniFi's error messages aren't passed on, since a console or a proxy in front of
it can echo what a request carried; errors are described by their status.

## Observers

Strategies B and C (`docs/observers.md`): every read reports the data it disclosed, named by the
UniFi endpoint it came from, and the Workshop shows it only to a collaborator whose own key can
read all of it there. UniFi roles differ in what they can see: a Network role can be limited to
some sites, a Protect role to some cameras, and not every role may read WiFi passwords.

All IDs start `console/<consoleId>/app/<network|protect>`, which alone names the application's own
information, such as the version a site's or Protect's `describe()` returns. Then:

- Network: `/site/<siteId>` for the site's details; `/devices/<siteId>`, `/clients/<siteId>`,
  `/networks/<siteId>`, `/wifiNetworks/<siteId>` and `/vouchers/<siteId>` for those lists, with
  `/site/<siteId>/voucherCode/<id>` for each voucher whose working code a read returned, passed
  only if the collaborator's key finds that voucher with its code;
  `/site/<siteId>/wifi/<wifiNetworkId>` for one WiFi network's settings, and
  `/site/<siteId>/wifiPassword/<wifiNetworkId>` for its password, which a collaborator passes only
  if the settings their key reads include it; and
  `/site/<siteId>/device/<id>`, `/site/<siteId>/deviceStatistics/<id>` and
  `/site/<siteId>/client/<id>` for one device's details or statistics or one client's details,
  since a route can be allowed apart from the list it's under.
- Protect: `/nvr/<id>` for the alarm, which a collaborator passes only if their key reads the same
  NVR, and `/camera/<id>`, `/sensor/<id>` or `/light/<id>` for each device a read showed, with
  `/list/<cameras|sensors|lights>` for the list it came from. A snapshot also reports `/snapshot/<id>` (or `/packageSnapshot/<id>`),
  since a camera's images can be allowed apart from its details, for example by a Cloudflare
  Access policy on the snapshot path. A listing that found nothing still reports its list.

Checks:

- A collaborator's direct connection passes only for a binding its owner also connected directly,
  at the same console URL. What a direct connection knows about its console came from whatever
  answered at the URL its owner typed, so it can't vouch for a console reached any other way: a
  server the collaborator runs could claim any MAC address. It then calls, with its own key, the
  endpoint each requirement names, and for a site's details also needs the site in its own site
  list, read to the end.
- A collaborator's cloud connection needs Site Manager to list the console, matched by host ID or
  by MAC address, and is then checked the same way through the Cloud Connector, which reaches only
  consoles the collaborator owns. A collaborator who only administers the console passes nothing,
  since nothing can show what their role may read.

A binding's title is what UniFi calls the resource, as are the names in approvals: the Workshop
shows both to everyone the workspace is shared with, and sharing a workspace shares those names.
The data behind them stays behind the checks above.

A read that returns a working WiFi password or voucher code also marks the workspace as holding
restricted data, so the Workshop keeps it from leaving through web fetches and actions elsewhere.

A check that can't be made (the console doesn't answer, the binding owner's own connection no
longer reaches it, or the collaborator reconnects with another key while it runs) refuses everyone
rather than guessing.

## Requests

The API key never leaves the account's Durable Object, which sends every request:

- Each console has a request budget: bursts of 10 and 80 a minute through the Cloud Connector
  (under its limit of 100), bursts of 20 and 5 a second directly. A request waits at most 5
  seconds for its turn. A 429 pauses the console until the time UniFi gives.
- Answers are cached for 5 seconds, and the console list for a minute; snapshots aren't cached. A
  change clears its console's cache.
- When UniFi starts rejecting the key, the Workshop is told once, so the user can reconnect.

## Not supported yet

- Events and hooks. Protect's events are WebSocket-only, which the Cloud Connector can't carry.
- Sirens, relays, arming the alarm, and UniFi Access.

## Development

- `pnpm --filter @gadgets/unifi-gatekeeper test:run` runs the Node suite (`vitest.config.ts`)
  and the workerd suite (`vitest.worker.config.ts`, `__tests__/workerd/`).
- `__tests__/fake-unifi.ts` is a fake Site Manager, Cloud Connector, and console, used by both.
- `__tests__/openapi/` holds the subsets of UniFi's OpenAPI specs this package uses, and
  `openapi-contract.test.ts` checks every request the client makes, and the fake's answers,
  against them. Refresh them with
  `node packages/gatekeeper-unifi/scripts/vendor-openapi.ts [--from DIR]`.
