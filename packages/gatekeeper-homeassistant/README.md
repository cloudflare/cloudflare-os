# Gatekeeper Home Assistant

This package provides a [Home Assistant](https://www.home-assistant.io/) gatekeeper for Gadgets. It lets a Gadget read state from a connected HA instance, call services on devices (turn lights on/off, set thermostats, lock doors, etc.), edit Lovelace dashboards, render templates, and read history — all mediated through the standard Gadgets approval queue.

## Authentication

The gatekeeper uses Home Assistant's **long-lived access token (LLAT)** + **URL** combination. There's no OAuth flow because:

- Each HA instance has a different URL (no central directory).
- LLATs don't expire (10-year default lifetime).
- LLAT is the path every other HA-adjacent tool uses, so users are familiar with it.
- It works for both Nabu Casa Cloud users and self-hosted users on a LAN.

When the user connects an account, they paste their HA URL and an LLAT into a form. The gatekeeper validates by calling `GET /api/`, then stores both in the per-user Durable Object.

### Reachability

The gatekeeper makes HTTP and WebSocket calls to the configured HA URL. On a Cloudflare-hosted Gadgets deployment, that means HA must be publicly reachable (via Nabu Casa, Cloudflare Tunnel, port-forwarding, etc.). On a self-hosted (workerd) deployment, LAN addresses like `http://homeassistant.local:8123` and `http://192.168.x.x:8123` work fine — that's the intended setup for users running Gadgets on the same network as their HA.

## Resource granularities

Five granularities are exposed; each comes with its own configurator UI for picking a specific resource from the connected HA instance:

| Granularity   | What it grants                                                      |
| ------------- | ------------------------------------------------------------------- |
| Whole instance | Access to every area, device, entity, dashboard, and service.       |
| Area          | A single area (room) — its devices and entities only.               |
| Label         | All entities carrying a particular HA label.                        |
| Device        | A single physical device and the entities it provides.              |
| Entity        | A single entity (light, sensor, switch, etc).                       |

## TypeScript API

Bindings expose one of `HomeAssistantSession` (whole-instance), `Area`, `Label`, `Device`, or `Entity`, depending on the granularity granted. Common operations:

```ts
// Whole-instance:
const config = await session.getConfig();
const areas = await session.listAreas();
const lights = await session.listEntities({ domain: "light" });

// Capability-based:
const light = await session.getEntity("light.kitchen");
await light.turnOn({ brightness: 200 });
const state = await light.getState();  // reflects the simulated post-write state

// Area-scoped service call (affects every entity in the area):
const livingRoom = await session.getArea("living_room");
await livingRoom.callService("light", "turn_off");

// Templates:
const temp = await session.renderTemplate("{{ states('sensor.outside_temp') | float }}");

// Dashboards:
const dashboard = await session.getDashboard("lovelace");
const dashboardConfig = await dashboard.getConfig();
// ... mutate the JSON ...
await dashboard.saveConfig(dashboardConfig);
```

See `src/types.d.ts` for the complete API and `@example` blocks for every method.

## Approval & simulation

Every read calls `authorizeObservation` and every write goes through `submitAction`. Writes do **not** execute against HA until the user approves them, or until an always-approve rule the user enabled covers them.

Two kinds can be auto-approved, each only once the user enables a rule for it (`src/auto-approval.ts` holds the verdicts):

- **Control devices** (`control-devices`): allow-listed device services such as `light.turn_on`, `switch.toggle`, `climate.set_temperature`, `media_player.volume_set` or `cover.close_cover`, when every entity the call reaches, through `target` or target keys in `data`, is known to the registry and is not a config or diagnostic entity. Entities of script-backed integrations (template, command_line, rest, group, universal, switch_as_x) are excluded, since turning one on runs whatever it was configured to do. Covers must be blinds, curtains, shades, shutters, awnings or dampers, named by entity id; door, garage, gate and window covers, and covers of unknown class, are excluded. A capability scoped to an entity, device, area or label cannot widen its target through `data`, and an entity binding whose domain has no allow-listed service (a lock, for instance) does not offer this kind.
- **Edit dashboards** (`edit-dashboards`): `Dashboard.saveConfig`, which reverts to the exact previous configuration. A configuration that could make the browser load an address off the Home Assistant origin always needs manual approval: absolute or scheme-relative URLs (including `https:host` with no slashes), backslashes, HTML character references, Jinja or JavaScript templates, `javascript:` links and `custom:` cards or strategies. Only a whole-instance binding reaches dashboards, so only it offers this kind.

Everything else always needs manual approval: other service calls (locks, alarm panels, `notify`, `tts`, scenes, scripts, automations, helpers, `homeassistant.*`, custom integrations) under **Call Home Assistant services**, and `fireEvent` under **Fire events**.

Until approval, reads reflect a **simulated post-action world**: e.g. after `entity.turnOn()`, an immediate `entity.getState()` shows `state: "on"` even though HA hasn't been touched. This lets agents chain reads and writes without waiting for user approval. Simulation predicts final states only — no transition timing, and unrecognized service calls (custom integrations, scenes, scripts, templates) leave state untouched.

See the **APPROVAL & SIMULATION** section at the top of `src/types.d.ts` for the full list of caveats.

## Phase 2 — not yet implemented

- **Caching.** Every read does a fresh registry fetch. Once caching is added, area / device / label-scoped reads will be much cheaper.
- **Hooks (push events).** `setHook` is a no-op. WebSocket `subscribe_events` / `subscribe_entities` would enable a `HomeAssistantHook` interface — e.g. a Gadget receiving a callback when a motion sensor fires.

## Implementation notes

- **Service calls go through the WebSocket API.** HA's REST `POST /api/services` endpoint expects target fields flattened at the top level of the body and has uneven support for area / label / floor targets across versions. The WebSocket `call_service` command is HA's modern path and supports the full target shape natively.
- **All actions get an integer `id`** assigned by a per-DO counter. Pending actions are stored under `pending:<id>` in DO storage so reads can simulate the post-action state.
- **Defensive validation.** Malformed action bodies (e.g. an agent passing a single options object instead of positional arguments) fail synchronously with a rich error message that includes a suggested corrected call.

## Files

```
src/
├── homeassistant.ts        # main: Vendor, UserAccount, User, GatekeeperImpl, Session impls
├── homeassistant-api.ts    # REST + WS clients (incl. timeouts and error-body sanitization)
├── approvals.ts            # describeAction, executeAction, applyRevertForEntity, ...
├── auto-approval.ts        # action kinds and the per-call auto-approval verdict
├── simulation.ts           # pure overlay-at-read-time helpers
├── registry-utils.ts       # shared resolveTargets helper
├── types.d.ts              # public Session/Area/Label/Device/Entity/Dashboard interfaces
└── configurator/           # 5 picker UIs (instance / area / label / device / entity)
```
