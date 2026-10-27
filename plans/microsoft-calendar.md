# Calendar, the Microsoft 365 gatekeeper's third resource

Outlook calendars for agents and gadgets: read a calendar, embed one in a gadget that can be shared
safely, check when people are free, and create or change events with approval. It is a resource of
`gatekeeper-microsoft`, beside SharePoint and Outlook mail, so one connection, one app registration
and the same tenant pinning, credentials and Graph client serve all three.

Three requirements shape it: answering "when is everyone free?", binding at a granularity that lets
a gadget be useful without over-sharing (one calendar at a chosen level of detail), and knowing who
a calendar is already shared with, so a gadget built on it can be shared with exactly those people.

## Use cases

1. **A calendar in a gadget, shared with the team.** "Show our team calendar on the team's
   dashboard." The gadget reads one calendar; everyone who can open the gadget must already be
   able to see that calendar at that level of detail in Outlook, and nothing else may leak: not the
   owner's other calendars, not their private appointments, not other people's availability.
2. **Office hours / booking.** "Show when I'm free next week so people can pick a time." The gadget
   needs free/busy only: shareable with the whole organization, revealing no titles.
3. **The agent's calendar in chat.** "What's on tomorrow? Move my 1:1 with Sarah to Thursday and
   find an hour next week when Sarah and Bob are both free." Every calendar the user has, full
   detail, availability of colleagues, and writes with approval. Not meant to be shared.
4. **Scheduling without reading calendars.** "Find a time for these five people." Availability of
   people in the organization, and nothing about any event.

## Verified live

- **Availability.** `POST /me/calendar/getSchedule` works for any colleague with only
  `Calendars.Read(Write)`: a colleague gets the user's free/busy (`availabilityView` and busy items
  with no subject) under the organization's default `freeBusyRead`; the user gets their own
  subjects. Only the **default** calendar counts toward free/busy: a secondary calendar's events
  never appear in it. Working hours come back per person (days, start, end, Windows time zone).
  Someone whose organization-wide sharing is `none` comes back HTTP 200 with an `error` on their
  row (`responseCode` 5016) and no view, so a row's error, not the status, says it wasn't readable.
- **`findMeetingTimes` is unreliable**: with the organizer free inside working hours it answered
  `OrganizerUnavailable` with no suggestions. Free times are computed from `getSchedule` instead
  (`calendar-free.ts`), deterministically and explainably.
- **Calendar ACLs are readable by the owner.** `GET /me/calendars/{id}/calendarPermissions` lists
  each sharee (`emailAddress.address`, `role`: `freeBusyRead`, `limitedRead`, `read`, `write`,
  `delegateWithoutPrivateEventAccess`, `delegateWithPrivateEventAccess`) and, where set, a
  `My Organization` entry (the default for everyone inside). A new secondary calendar has no
  `My Organization` entry: nobody but its sharees. Sharees can't read the list (403).
- **Reading someone else's calendar needs `Calendars.Read.Shared`** (`/users/{owner}/calendars/…`
  is 403 without it, even for a sharee with `read`). Even with it, only a delegate can list
  someone's calendars or open a secondary one through their mailbox: a sharee with `read` on a
  secondary calendar gets 404 for it (and 403 for its events). A sharee reaches the owner's main
  calendar only. A secondary calendar shared with someone who isn't a delegate opens only through the copy
  in the sharee's own list once they accept the share, which a binding refuses, because that copy is
  the owner's calendar, not the sharee's.
- **The calendar segment of an event path is ignored.** `/me/calendars/{team}/events/{id}` returns
  an event of the *default* calendar (200). And `/events/{id}/calendar` names the **default**
  calendar for an event in the team calendar. Both are wrong-but-plausible, so neither is trusted.
- **Membership is the MAPI parent entry ID.** An event's `PidTagParentEntryId` (extended property
  `Binary 0x0E09`) equals its calendar's `PidTagEntryId` (`Binary 0x0FFF`), for single events and
  for occurrences of a series, on a direct GET. That is how an event ID is checked against a
  calendar binding. A calendar-scoped `calendarView` (`/calendars/{id}/calendarView`) is confined
  to that calendar, so listings are scoped by construction (and still checked).
- **`transactionId` makes creation idempotent.** Two POSTs with the same `transactionId` return the
  same event (201 both, same ID). It can't be filtered on, but a replay just POSTs again.
- **Time zones.** Mailbox settings name Windows zones ("Pacific Standard Time"); Graph returns
  `dateTime` without an offset, in the zone `Prefer: outlook.timezone` asks for. Every request asks
  for UTC, and times are converted to the user's IANA zone only when shown (`calendar-time.ts`).
- An invitee's copy of a meeting shows `showAs: tentative`, `responseStatus: notResponded`.

## Bindings

```ts
type CalendarScope = { access: "read" | "edit" | "schedule" } & (
  | { kind: "all" }                       // every calendar in the user's list, and availability
  | { kind: "availability" }              // free/busy of people in the organization, nothing else
  | {
      kind: "calendar";
      owner: { kind: "me" } | { kind: "shared"; id: string; address: string };
      calendar: { id: string; entryId: string; name: string };  // immutable ID, MAPI entry ID
      details: "freeBusy" | "limited" | "full";                 // what of each event is revealed
      privateEvents: "busy" | "show";                           // private events: a busy block, or shown
    }
);
```

Resource URL `https://outlook.office.com/calendar/*` (`calendar-scope.ts`):

- `…/calendar/` (or any of Outlook on the web's own `…/calendar/view/…` links): all calendars;
  `…/calendar/availability`: availability only.
- `…/calendar/<calendar>`, where `<calendar>` is `default` or `id/<id>`, prefixed by an owner
  address for someone else's (`…/calendar/sarah@contoso.com/default`). Query:
  `details=freeBusy|limited|full` (default `full`), `private=show` (default `busy`),
  `access=read|edit|schedule`. The owner's address and `default` resolve once, at binding, to IDs
  (`calendar-resolve.ts`), so renaming a calendar can neither break nor widen a binding.

A calendar from someone else that the user added to their own list is refused as the user's: it
must be connected as its owner's, since its sharing list (which decides observers) is the owner's.

**Detail levels** mirror Exchange's own sharing roles, so a binding reveals exactly what a sharee at
that role sees in Outlook:

| `details` | Each event shows | Exchange role that sees the same |
|---|---|---|
| `freeBusy` | start, end, all-day, show-as | `freeBusyRead` |
| `limited` | + subject, location | `limitedRead` |
| `full` | + body, organizer, attendees and responses, online meeting, categories, recurrence | `read` |

`privateEvents: "busy"` (the default) shows a private event as a busy block, as Exchange does to
everyone but delegates with private access; `show` reveals them, which only the owner and such
delegates could see, so it makes a binding effectively unshareable.
In `busy` mode a private event's ID still lists (for free-time math) but every read of it returns
the busy block, and no write can touch it. Confidential events are treated as private.

**Access levels.** `read`; `edit` (create, change and delete events that have no attendees:
nothing leaves the mailbox, auto-approvable); `schedule` (meetings with attendees, changes and
cancellations of meetings the user organizes, and responses to invitations: each sends mail, so
**never** auto-approvable). Only a `details: "full"` binding can be `edit` or `schedule`. The
deployment caps the level with `MICROSOFT_CALENDAR_ACCESS`, and the grant caps it too
(`Calendars.Read` gives `read`).

Shared calendars need `Calendars.Read.Shared` and `User.ReadBasic.All` (and
`Calendars.ReadWrite.Shared` to change them). A link to one is refused at binding without them; a
link that asked for no level, to a shared calendar the grant can read but not write, is bound at
`read`.

## The guard (`calendar-session.ts`)

The chokepoint is `CalendarContext.guarded(id)`: every event ID is read with its parent entry ID
(0x0E09), and admitted only if

- `kind: "calendar"`: the parent entry ID equals the bound calendar's entry ID;
- `kind: "all"`: the parent is one of the user's calendars (their list, by entry ID);
- `kind: "availability"`: never (no event IDs at all).

Then it is redacted to the binding's detail level (and private events to a busy block,
`calendar-events.ts`) before anything else is read, returned or changed. 400, 403 and 404 all mean
"not in this binding", and an event outside the binding is refused in the same words as a missing
one. Provisional `~N` IDs of events not yet created resolve first. Listings use the calendar-scoped
`calendarView` and are re-checked by parent entry ID and redacted row by row.

## Observers: sharing a gadget

Every read names what it revealed as **units** (`calendar-observers.ts`):

- `calendar:<ownerId>:<calendarId>:<level>`: events of a calendar at `freeBusy`, `limited`,
  `full`, or `private` (a private event shown in detail).
- `calendars:<ownerId>`: anything an all-calendars binding revealed.
- `availability:<address>`: a person's free/busy.

An observer must first have a working connection in the binding owner's tenant, and is then
admitted only if they could see every unit in Outlook themselves:

- **A calendar the connected user owns**: decided from the owner's side, from Exchange's own ACL
  (`calendarPermissions`, `calendar-acl.ts`), so the observer needs no new permissions. The
  observer's role is their explicit entry (matched on the primary SMTP address from their own
  verified connection), else the `My Organization` entry if their address is in one of the
  organization's verified domains, else none. Groups in the ACL can't be expanded, so a group entry
  can only lower the default role, never raise it. Required role: `freeBusy` → `freeBusyRead`,
  `limited` → `limitedRead`, `full` → `read`, `private` → `delegateWithPrivateEventAccess`. The
  owner themselves always passes. Sharing lists are cached for two minutes, so a share removed in
  Outlook stops counting within that long.
- **A calendar someone else owns** (shared with the user): Exchange won't show its ACL to a sharee,
  so only that calendar's owner can observe it.
- **`calendars:`**: only that user passes, which is right for a chat binding.
- **Availability**: probed as the observer, with their own `getSchedule`: it must answer for that
  person with something other than "no information" (an all-`4` `availabilityView`, which
  `parseSchedule` turns into an error, so a read treats such a person the same way: not free, but
  unreadable). What was revealed is status only (never
  subjects, even the user's own), which is what `getSchedule` gives any colleague.

## The agent's API (`calendar-types.d.ts`)

Read (`CalendarReader`):

- `getOverview()`: what the binding covers in words, the user's time zone (IANA) and working hours,
  the detail level, and what the session may do.
- `listCalendars()`: each calendar with owner, whether the user can edit it, and color.
- `listEvents({ start?, end?, calendarId?, search?, pageSize? })`: events and occurrences in a
  window, earliest first, through a cursor; at most 62 days per call. Times are ISO 8601 with the
  user's offset (`2026-10-18T08:00:00-07:00`), and all-day events are dates.
- `getEvent(id)`: one event at the binding's detail; at `full`, its body as safe Markdown
  (`outlook-content.ts`'s sanitizer: hidden text and tracking images removed, links listed with
  real targets), attendees with responses, online meeting join link, recurrence in words.
- `getAvailability(people, start, end)` (`all`, `availability`): each person's busy blocks
  (status only), working hours, or why they can't be seen. A calendar binding of the user's own
  default calendar answers for the user alone, since Exchange free/busy is per person.
- `findFreeTimes({ duration, start, end, people?, includeMe?, workingHoursOnly?, tentativeIsFree?,
  limit? })`: slots everyone is free, computed from availability (tentative counts as busy unless
  asked), inside everyone's working hours by default. A `calendar` binding without `people` uses
  that calendar's own busy time.
- `findPeople(query)`: colleagues from the People API, for addressing.

Write (`CalendarSession`, `edit`/`schedule`):

- `createEvent({ subject, start, end, allDay?, location?, body?, attendees?, onlineMeeting?,
  showAs?, sensitivity?, reminder?, categories?, recurrence?, calendarId? })`. With attendees it is
  an invitation (`schedule`).
- `updateEvent(id, changes, { series? })`: an occurrence by default, the whole series with
  `series: true` (a series' times can't be changed); fenced on `changeKey`, refused if the event
  changed after it was proposed. On someone else's meeting only the user's own fields (categories,
  show-as, reminder) can change.
- `deleteEvent(id, { series?, message? })`: deletes an event without attendees; for a meeting the
  user organizes, cancels it with the message (`schedule`). Deleting someone else's meeting is
  refused in favour of declining it.
- `respond(id, "accept" | "tentative" | "decline", { message?, notify?, propose? })`.

Not offered at any level: sharing a calendar or changing its permissions, creating or deleting
calendars, delegates, forwarding events, changing someone else's event.

## Actions (`calendar-actions.ts`)

| Kind | Actions | Auto-approvable | Revert |
|---|---|---|---|
| `calendar.events` | create, change, delete an event without attendees | Yes | delete / restore the previous fields / recreate it |
| `calendar.invitations` | create, change or cancel a meeting with attendees | **Never** | can't be unsent |
| `calendar.shared-events` | create, change, delete an event in a calendar someone else owns (`createSharedEvent`, `updateSharedEvent`, `deleteSharedEvent`: the `calendar.events` definitions under a kind that is never auto-approved, since "your own events" doesn't cover them) | **Never** | as `calendar.events` |
| `calendar.responses` | accept, tentatively accept, decline, propose a new time | **Never** | can't be unsent |

Every action reads back as done while it waits (`calendar-overlay.ts`), with a provisional `~N` ID
for a new event. Creation carries a `transactionId` fixed at proposal, so a replay after a crash
returns the event already made instead of a duplicate. Changes and deletions are fenced with
If-Match on the change key read at proposal. Cancel and respond have no If-Match in Graph, so they
read the change key first and refuse if it moved. Meeting updates, cancellations and responses are
`claimBeforeApply`, so a crash can't send them twice. Reverting a deletion recreates the event
under `transactionId: revert-<id>-<submittedAt>`, so a retried revert can't make two, and says the
event comes back with a new ID. The approver of an invitation sees every attendee, each marked when
outside the organization, and for a change of a meeting, what changes and who is told.

## Out of scope

Change notifications (hooks) for calendars, event attachments, room and resource booking, Teams
meeting options. Each fits the shapes above.

## Tests

- `__tests__/calendar.test.ts`: the pure modules: URL grammar, detail redaction, the free-time
  solver (working hours across zones, daylight saving, tentative), the ACL role ladder, observer
  units, permissions, and the agent types bundle.
- `__tests__/calendar-session.test.ts`: sessions over a fake Graph at `fetch`, including a Graph
  that lists a foreign event, and binding-time resolution.
- `__tests__/calendar-actions.test.ts`: apply, fencing, revert and descriptions.
- `__tests__/contract/calendar.test.ts`: live, against a tenant where a team calendar is shared
  `read` with one colleague and `freeBusyRead` with another: a `full` binding admits the first and
  refuses the second, a `freeBusy` binding admits both, a private event never reaches the sharee,
  an event ID from another calendar is refused, availability and free times across users,
  create/update/delete with revert, and an invitation the colleague accepts. A calendar shared
  with the user is tested from its owner's side (who may observe a binding of it); the
  shared-calendar binding path itself is covered by fakes.
