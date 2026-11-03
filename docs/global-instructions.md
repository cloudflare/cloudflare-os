# Personal global instructions

Save working preferences in **Profile → Personal global instructions**. They apply to your agent
turns across new and existing workspaces; no `RULES.md` file is created or imported. **Discard edits**
restores the loaded/saved text. **Clear saved instructions → Confirm clear** removes it from future
turns. Empty or whitespace-only instructions add nothing to the prompt.

## Scope and precedence

Platform/system instructions, deployment policy, and explicit task/workspace instructions (including
selected skills) take precedence. These are model-guided defaults, not authorization controls.
Shared workspaces use the invoking participant's instructions, not the owner's, through the user
identity recorded for the invocation. A turn keeps one snapshot across tool calls, retries and
compaction; a new turn or a resume after restart reads the current document.

## Privacy

The document is stored in your User Durable Object, not the public profile or workspace state.
Only the authenticated settings API can edit it; gadgets and agent tools cannot. Inference receives
it transiently, outside the shared static prefix and behind workspace and per-edit cache salts.
Compaction uses the transcript-only summarizer when personal instructions are present.

**Do not store secrets here.** Your model provider receives the text, and an LLM may disclose or
paraphrase it in shared replies, artifacts or summaries. Clearing it does not erase earlier outputs
or purge provider caches/logs.

## Limits

Saves accept **8,000 UTF-16 code units** (an emoji may count as two), without truncation. The formatted
block reserves one token per UTF-8 byte, capped at **one quarter of the model's input budget**; a turn
over that cap fails visibly. Previous usage measurements receive the full reserve because they may
predate an edit, so compaction can happen early. The model's overall context limits still apply.
