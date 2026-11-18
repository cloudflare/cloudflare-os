# Agents as entities

Design record for how the reworked Workshop (`packages/workshop-app`) shows what the backend calls
agent spawners. Branch `pjones/workshop-app-port`; no kernel changes.

## Problem

A gadget can start agents of its own (an agent spawner binding, `AgentSpawnerConfig`): an email
gadget starts one for each email that arrives, each in a chat of its own, a run. Those runs were
listed among the workspace's chats, so a workspace with a busy agent was mostly its runs, and the
one thing a person needs from them (a run waiting for their approval or a connection, or one that
failed) was only found by opening them. The UI also said "agent spawner".

## What the backend offers

- An agent is a gatekeeper workpiece. Nothing lists them: `subscribeToWorkpieces` delivers gadgets
  and worktrees only. A gadget's `listBindings()` names it (a binding with no `vendorId`), and the
  gatekeeper's `getCreationSpec()` says it is one (`type: 'agentSpawner'`), with its `displayName`,
  `modelId` and `modelName`. Nothing says what it is for.
- A run is a chat with `spawnerId` (the spawner's id) and `spawnerName` (its name when the run
  started). Runs made before `spawnerId` was recorded have only the name.
- How a run stands: `activeAgent` (at work), `awaitingDecision` (stopped on an action it waits for,
  a connection request, or a restricted fetch), `proposedChangeWorkpieces` (changes to keep). An
  action that does not stop the run waits in the action log (`listActions({filter: 'pending'})`,
  `subscribeToActions()`), naming its chat by `chatId`, which the dev backend left out for actions
  made by a spawned agent's call into its gadget; the run's own `action` message names the action.
  Nothing says a run failed: its last message is an `error` (code `stopped` is a person stopping
  it).
- When an agent runs is its gadget's: the gadget's hooks (`listHooks()`, with schedules from the
  scheduler) set off the gadget's code, which starts the agent. Nothing says which hook starts which
  agent.
- An agent can be renamed or removed as a workpiece (`setTitle`, `remove`), but not paused, and its
  model cannot be changed.

## Design

**An agent is a thing with a page; its runs are under it.** The workspace page gets an Agents tab
beside Chats, Library, Automations and Members. Its chats list leaves runs out, as does the
gadget page's Chat menu (already). Each agent has a page (`/workspace/<id>/agent/<key>`), headed
by the workspace's crumb and its own, as a chat is: a robot and its name, then what it is (the
gadget that starts it, linked; the model it thinks with, or that it has none and its runs wait for
a person; when it runs, from its gadget's automations; how many runs and when the latest), then
its runs by when, each saying how it stands (Running, Waiting on you, Failed, Changes to keep,
Done) and opening its conversation. A run's header has the agent's crumb, so debugging goes
workspace, agent, run and back.

**What needs a person is said where they already are.** Over the workspace page's tabs, a banner
(warning colour for waiting, danger for a failed latest run) names the agent and opens the run,
or the tab where there are several. The Agents tab is counted, and starts with Needs you: the
runs waiting and the failed latest runs, each opening straight into the run. An agent's row says
what it wants in place of its line, with a dot on the robot in that colour (green while a run is
at work). In the sidebar, a workspace with runs waiting says so in place of when it was last
active, with a dot. A failed run counts only while it is its agent's latest: the next run that
works puts it right.

**Words.** "Agent" everywhere; "run" for one of its conversations. A request for one in a chat
reads "Set up an agent", with a robot, rather than "Connect Agent spawner".

### Why a tab of its own, not Automations

Automations are triggers (a schedule, an event) on a gadget; an agent is a worker a gadget calls,
which may be set off by an automation, by someone using the gadget, or by nothing yet. Folding
agents into Automations, as the scaffold did, hides "waiting on you" under a tab named for
schedules, and makes the agent a footnote to a trigger it may not have. Main's frontend also gives
agents their own tab beside Chats. The agent's page shows the link the other way: when it runs is
its gadget's automations.

## How it is read

`WorkspaceAgents` (plain class, tested) keeps one workspace's agents live: `subscribeToChat()` and
`listChats()` for runs, the action log for actions waiting, the last ten messages of the latest
thirty runs that ended (for failure and for which actions are theirs), and each gadget's bindings
and their creation specs for what each agent is, so an agent shows before it has run. The sidebar
asks the user's other workspaces (those active in the past week that they build in, three at a
time, every two minutes) with `listChats()` and `listActions()` pipelined on one `openWorkspace()`
(`AgentsWaiting`), which wakes each; the open workspace reports its own count as it changes.

## Gaps, and the kernel changes that would close them

| Gap | Kernel change |
|---|---|
| The sidebar wakes every recently active workspace to count runs waiting | a per-workspace count of runs waiting on the user, on `listWorkspaces()` or the unread summary (`WorkspaceUnreadSummary`) |
| The sidebar misses a run waiting on an action that does not name its chat | `ActionLogEntry.chatId` on every action a spawned agent's call makes |
| Failed is read from the last messages of the latest runs only; an older failure says Done | `lastTurnFailed` (or the error) on `AiChatMetadata` |
| An agent's gadget and model need a round trip per gadget and per binding | `Overseer.listAgentSpawners()`: id, name, model, the gadgets bound to it |
| Nothing says what an agent is for | a description on `AgentSpawnerConfig` |
| When it runs is its gadget's automations, a guess when a gadget has several agents | the hook or caller that starts a run, on the run |
| No pausing, and no changing its model, here | pause/resume and a model setter on the spawner |
| A run's approvals are answered in the run, not from the agent's page | none: the run's own cards; lifting them out (main's agent pane does) is a follow-up |
| The scripted chats' runs open the scenario's one chat | none |

Rename and delete exist (`setTitle`, `remove` on the workpiece) and are left for a follow-up, as is
the run's settings page saying it is a run.
