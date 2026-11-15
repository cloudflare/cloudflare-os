# Always-on agents

Status: plan only. Nothing here is built yet.

## The ask

Let people build agents that are "always on", in the sense of Anthropic's
[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents),
without setting up an agent spawner by hand or adding one to a gadget. It shouldn't feel like an
agent spawner, and it doesn't have to be one.

## What "always on" means

The article says the term describes what the person experiences, not how it runs. The agent sleeps.
An event wakes it for a short **run**, it does the work, it writes down what it learned, and it
sleeps again. A run happens inside a **session**: a transcript that can be resumed or started fresh.

Five primitives make that loop:

- an **inbox** of events, durable and deduplicated, served by one worker at a time;
- **timers**: schedules, and follow-ups the agent sets for itself;
- **memory** that outlives every run;
- **permissions**, with credentials kept out of the agent;
- an **outbox**: outcomes, not traces.

A run ends in one of three ways: it says something, it says nothing, or it stops on a decision
and waits.

## What we already have

Most of the loop exists already. It is spread across concepts that nobody would recognise as one
agent.

| Primitive | What exists | What's missing |
|---|---|---|
| Inbox | Hooks (`BoundHookInfo`). A hook fires from the scheduler or a gatekeeper's event and wakes a gadget's code, or a chat's agent when it is bound to the chat (`chatId`). | Hooks wake a chat or a gadget, never an agent of its own. There's no dedupe, and nothing batches events that arrive during a run. |
| Timers | `gatekeeper-scheduler` schedules, listed under Automations. | Follow-ups: "check again Thursday" as a one-shot timer the agent sets on itself, owned by the agent and not by a chat. |
| Sessions | Chats. A spawner's run is a chat of its own (`spawnerId`, `parentChatId`). | A rule for whether an event resumes a session (a reply to its email) or starts a new one. |
| Memory | Nothing per agent. A chat agent's context is its transcript; the Context Library holds documents the user shares. | Memory files per agent: instructions, notes, task progress. These are kept by the kernel and read at the start of every run. |
| Permissions | Gatekeepers: the credential proxy is the architecture. Each action is "Ask first" or "Automatic" (`autoApprovable`, the workspace rules). The spawner's `env` holds only the bindings it was given. | Nothing new. This is our strongest part. |
| Waiting on a person | `awaitingDecision`, approval cards, and connection requests: a run stops, and the person's answer resumes it. | Making sure a spawned run's wait reaches the person through `permissionRequested`. |
| Outbox | `agentReport` posts each run's result in the chat that asked (`reportsToChatId`). User notifications (`UserNotification`) for a finished task or a pending approval. | A notification that is the agent's own message, and a default of saying nothing unless it matters. |

The gap isn't machinery. It's that there is no *thing* called an agent that owns all of this. A
spawner is a capability a gadget holds, a hook belongs to a chat or a gadget, and a chat is a
transcript. "Always on" asks for one noun.

## The product

**An agent is something you make, as you make a gadget.** It has a name, instructions in plain
words, what it can use, what wakes it, and where it tells you things. It sits in the Library beside
gadgets, as its own kind with its own tab, and on Home's list of what's running. It is not a binding.

Making one should not take a form. The usual way is from a chat:

> "Every morning, go through my inbox, draft replies to anything from customers, and tell me
> what needs me."

The chat's agent proposes an agent as a card: its name, its instructions, what wakes it (weekdays
at 8:00, and when an email arrives from a customer), what it can use (Gmail, Ask first for
sending), and where it reports (here, a short summary). Accepting the card makes it. It is the
same accept-a-proposal flow chats use for changes today. No spawner dialog, and no adding it to a
gadget.

The other ways in:

- **"Make this always on"** on a chat that already does the job by hand. It turns the chat's last
  few turns into instructions and proposes the same card.
- **From a blueprint.** An agent can ship in a blueprint as a gadget does: instructions, triggers
  and access as a symbolic env, resolved on install. Blueprints already carry a spawner's config
  symbolically (`api.ts` around `config: Omit<AgentSpawnerConfig, "env">`).
- **From a gadget**, still: a gadget that wants per-item agents (one per email, with only that
  email's stub) keeps using the spawner capability. That is the per-task isolation pattern, and it
  stays. It just isn't the way to get an always-on agent.

**Its page** grows from the agent page shipped in 5e1706df4:

- what it is told (editable);
- what wakes it, each trigger with its switch;
- what it can use, with Ask first or Automatic per kind of change;
- what it remembers, readable and editable, with each note deletable;
- its conversations by when, waiting ones first.

The person can always look in, though most of the time they never need to.

**Its voice** follows the article's advice to "start quiet and earn attention". By default a run
that finds nothing says nothing. A run that did something leaves one line in its report. A run
that needs the person stops and asks, and that ask reaches them (see notifications below) even if
they haven't opened the chat.

## Architecture

Keep the kernel diff small. Reuse what exists rather than building in parallel.

1. **An agent is a spawner with an owner of its own.** `AgentSpawnerConfig` gains `instructions`
   (the system prompt addition each run gets). Its owner is no longer a gadget: a spawner is
   already a workpiece (`gatekeeperId: WorkpieceId`) and can stand alone. `listAgentSpawners`
   stays its listing. The UI never says "spawner".

2. **Hooks can wake an agent.** `BoundHookInfo` has `gadgetId`, plus `chatId` for a chat's
   `self`. Add the agent as a third target, so that a firing becomes a run of that agent. The
   scheduler and every event gatekeeper then work unchanged; the hook just lands somewhere new.
   This is the "inbox" step. Before anything else, decide whether a hook firing should go through a
   per-agent durable queue in the kernel (dedupe by the event's source id, one run at a time,
   events that arrive mid-run batched into the next). The article argues strongly for this, and
   today a fast event source could start overlapping runs.

3. **Session rule.** An event names a thread key when it has one: an email's thread id, an issue
   key. An event with the key of an open run's session resumes that chat; anything else starts a
   new one. A follow-up timer resumes the session that set it.

4. **Follow-ups.** Give the agent a `remindMe(at, note)` tool that creates a one-shot schedule
   bound to the agent and the current session, through the scheduler gatekeeper, so it shows under
   Automations like any schedule and can be switched off.

5. **Memory.** A small per-agent store in the agent's Durable Object storage, kept as files:
   `instructions.md` (loaded every run, the same text as the config's `instructions`), `notes/*`,
   and `tasks/*` with an index. Tools `remember`, `forget` and `recall`; the index is loaded at
   start. Store pointers, not copies, of anything a gatekeeper can fetch again. "Dreaming"
   (consolidating notes across runs) waits until there is something to consolidate.

6. **Outbox.** `reportsToChatId` stays. Add one more target: the user's notifications
   (`UserNotification`, delivered live and by push), with a new kind for an agent's message
   beside `taskCompleted` and `permissionRequested`. Delivery stays a tool the run calls ("tell
   the user"), not a dispatcher table, until pacing is needed.

7. **Permissions.** Unchanged. An agent's access is its env bindings, each a gatekeeper, each kind
   of change Ask first unless the person made it Automatic. One thing to hold firm on: an agent's
   resources are never ambient. Only the person adds them, and a gatekeeper never asserts that
   itself (see the kernel note in the root `AGENTS.md`).

8. **Waiting.** `awaitingDecision` already marks the run. `UserNotification` already has
   `permissionRequested`. Check that a spawned run raises it like any chat does, and that it opens
   the run, so that "One waits on you" on the agent's row also reaches the person when they aren't
   looking.

## Phases

Each phase ships on its own and is useful alone.

1. **Agents as their own kind.** Hooks can wake a standalone agent (architecture items 1 and 2).
   The chat proposes "an agent that runs on this schedule / when this happens" as a card. The
   Library gets an Agents tab; the agent page from 5e1706df4 gains instructions and triggers. No
   memory yet: each run starts fresh with its instructions.
2. **The inbox.** Per-agent queue, dedupe, one run at a time, batching (item 2's open question).
   Do this before any event source that can burst, such as email or issue trackers.
3. **Memory and follow-ups** (items 4 and 5), with "What it remembers" on its page.
4. **Quiet by default and notifications** (items 6 and 8). Evals tune how often it speaks.
5. **"Make this always on"** from a chat, and agents in blueprints.

## Open questions

- **Model cost.** Every run uses the creator's model. Should an agent show what its runs cost, or
  have a ceiling per day?
- **Whose authority.** `updateAgentSpawner` makes the caller the creator, whose authority runs
  use. With shared workspaces, is that still the right rule for an agent everyone can see?
- **One agent or one per workspace.** An agent lives in a workspace, because its env is
  workspace-local. Is that what people expect, or will they look for "my agents" across
  workspaces? (The Library already lists across workspaces, so listing isn't the problem.
  Ownership is.)
- **When a chat becomes an agent.** Should the chat that proposed it be its first session, or stay
  a separate place where it is discussed?
