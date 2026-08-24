# Troubleshooting Desk

Troubleshooting Desk is a Cloudflare OS Gadget for revisitable, scoped AVA investigations. The
first runbook is `daily-grid`: it follows raw telemetry, effective mapping, Dagster materialization,
durable grid/cache output, served API, and Plant Overview presentation in that order.

The case requires a Plant, an explicit Plant-local date/time range and time zone, and a symptom.
Each inspection appends evidence snapshots. A revisit never replaces an earlier observation. The
case shows the first divergent boundary, confirmed facts, unresolved facts, and a safe next action.

The bundled slice uses a local simulated adapter. Its locators and values are marked `simulated`,
and its freshness policy says that they are not production evidence. A future deployment may wire a
narrow `AVA_EVIDENCE` read-only capability into `server.js`; the Gadget must not gain generic SQL,
Loki, Redis, or network access. No action method in this slice mutates AVA.
