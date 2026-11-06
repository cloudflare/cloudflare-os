# Gatekeeper PagerDuty

Connects PagerDuty users to Gadgets. A gadget can read incidents, services, teams, schedules and
who is on call, and act on incidents and schedules as the connected user: acknowledge, resolve,
add notes, reassign, open incidents, put people on call. Nothing reaches PagerDuty until a user
approves it. Every pending change is shown to the gadget as if it had already happened, so a gadget
keeps working while it waits. Everything a gadget sees is what the connected user can see in
PagerDuty.

Five resource types, each its own grant, all picked from one connect card:

| Resource | Link | What it reaches |
|---|---|---|
| PagerDuty Account | `https://<subdomain>.pagerduty.com` | Every incident, service, team and schedule the user can see. |
| PagerDuty Team | `…/teams/<id>` | The team's services and their incidents, its schedules and members. |
| PagerDuty Service | `…/service-directory/<id>` | One service and its incidents, and opening new incidents on it. |
| PagerDuty Incident | `…/incidents/<id>` | One incident: read it and change it. |
| PagerDuty Schedule | `…/schedules/<id>` | One on-call schedule: its shifts and overrides. |

EU accounts use `https://<subdomain>.eu.pagerduty.com` in place of the US host. A link to another
account than the connection's is refused.

## What a gadget can do

The full API is `src/types.d.ts`, which is also what agents read. In brief:

- **Account**, **Team** and **Service** list and open incidents (by default, open ones from the
  last 30 days), list who is on call, look up users by name or email, and list priorities. Account
  and Team also list and open services and schedules; a Team lists its members; a Service opens
  new incidents. Opening something from a broader binding returns the same interface a narrower
  binding gets, and a narrower binding refuses IDs outside it, such as another team's incident.
- **Incident** reads its details, log, notes and alerts, and acknowledges, snoozes, resolves,
  reassigns, escalates, requests responders, sets the title, priority or urgency, adds notes and
  posts status updates.
- **Schedule** reads its details, shifts and overrides, and adds or removes overrides.

Methods that take a user accept an email or a PagerDuty ID. `getMetadata().you` is the connected
user, so "my incidents" is `listIncidents({ assignedToMe: true })`.

Event hooks are not available yet: `subscribe()` throws on every binding.

## Actions

Each kind is a rule a user can enable for auto-approval. Kinds that page or email people outside
the binding, or delete, are never auto-approved.

| Kind | Methods | Auto-approvable |
|---|---|---|
| Acknowledge and snooze incidents | `acknowledge`, `snooze` | Yes |
| Resolve incidents | `resolve` | Yes |
| Change incidents' title, priority and urgency | `setTitle`, `setPriority`, `setUrgency` | Yes |
| Add notes to incidents | `addNote` | Yes |
| Reassign and escalate incidents | `reassign`, `escalate` | No: notifies the new assignees |
| Ask more people to respond to incidents | `requestResponders` | No: pages each responder |
| Post incident status updates | `postStatusUpdate` | No: emails subscribers and stakeholders |
| Open incidents | `createIncident` | No: pages whoever is on call |
| Add schedule overrides | `createOverride` | Only when it puts the connected user on call |
| Remove schedule overrides | `deleteOverride` | No: removes an override |

Approved changes can't be reverted automatically: PagerDuty's API has no undo for them.

## Setting up a PagerDuty app

The gatekeeper uses a private Scoped OAuth app, registered on the deployment's own PagerDuty
account (for example `acme.pagerduty.com`). Only that account's users can connect, US or EU alike.

1. Sign in as a Manager, Global Admin or Account Owner, and open **Integrations > Developer Tools
   > App Registration**.
2. Select **New App**, and leave its **App Type** as **Private**. Under **Functionality**, add
   **OAuth** and choose **Scoped OAuth**.
3. Grant it these scopes, exactly what the gatekeeper's endpoints need (`SCOPES` in
   `src/pagerduty-env.ts`): `incidents.read`, `incidents.write`, `services.read`, `teams.read`,
   `users.read`, `schedules.read`, `schedules.write`, `oncalls.read`, `priorities.read`,
   `escalation_policies.read`.
4. Add the redirect URL `$PUBLIC_BASE_URL/gatekeeper/pagerduty/oauth`, and save.
5. Copy the **Client ID** and **Client Secret** into the deployment's `CLIENT_ID` and
   `CLIENT_SECRET`.

PagerDuty grants a scope the app lacks by silently leaving it out, so a connection missing any of
them is refused, naming the ones missing.

A deployment behind Cloudflare Access needs nothing more: users sign in on PagerDuty's own page,
which sends them through the account's SSO if it has one.

### Local development

Export `PAGERDUTY_CLIENT_ID` and `PAGERDUTY_CLIENT_SECRET` in your shell or the root `.dev.vars`;
`pnpm dev-server` maps them into the worker's `CLIENT_ID` and `CLIENT_SECRET`. Register
`http://localhost:8787/gatekeeper/pagerduty/oauth` as a redirect URL.

## Sharing a workspace

Every read reports what it disclosed as subresource IDs, qualified by region and account, such as
`region/us/account/PABC123/service/PXYZ789`: the account, plus the bound team, service, incident or
schedule, plus every service, schedule or escalation policy a filter named or a page contained.
An incident read also reports its service. Empty pages and cached reads report the same.

A collaborator may observe a read only if their own PagerDuty connection can see every one of
those, checked with their login: the account by being the same account in the same region, with a
base role that sees the account's objects (not Limited Stakeholder or Restricted Access); each
object by PagerDuty opening it for them. A refusal (403 or 404) is a no; any other failure fails the
check. An answer is reused for 15 minutes if it allowed and 15 seconds if it denied, so a lost role
or team membership goes unnoticed for up to 15 minutes. See `docs/observers.md`.

## Limitations

- **Reconnect once a year.** PagerDuty caps a Scoped OAuth grant at one year.
- **A connection unused for 30 days dies.** Its refresh token expires, and the user must reconnect.
- **Disconnecting doesn't revoke at PagerDuty**, which documents no revocation endpoint. The grant
  lapses there (the access token within a day); a user can revoke it sooner from their PagerDuty
  profile.
- **Not covered:** merging incidents, incident workflows, the Events API, maintenance windows,
  editing escalation policies, status pages, custom fields and analytics.

## Troubleshooting

### "The PagerDuty connection has expired or was revoked. Reconnect the PagerDuty account."

PagerDuty refused the refresh token: the connection went 30 days unused, reached its one-year cap,
or was revoked. Reconnect from the Workshop's Connections page.

### "The PagerDuty app is missing permissions"

The app isn't granted every scope above. Add the ones the message names to the app, then connect
again.

### "That's a different PagerDuty user"

A reconnect was authorized by another user than the one the connection was made for. Sign in to
PagerDuty as that user and reconnect, or connect the other user separately.
