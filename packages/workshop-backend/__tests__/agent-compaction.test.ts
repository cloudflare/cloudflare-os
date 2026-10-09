import {describe, expect, it} from "vitest";
import {type AiChatAuthorInfo, type AiChatMessage, type AiChatMessageBody}
  from "@gadgets/workshop-shared/api";
import {
  buildCompactionState, buildSummaryPrompt, findCompactionBoundary, findProtectedFromSequence,
  foldProposedChanges, getModelTokenLimits, isCompactionTurn,
  shouldCompactChat, startsAgentTurn,
} from "../src/agent-compaction";
import {applyCodeChange, type CodeChange} from "@gadgets/workshop-shared/code-change";
import type {Api, AssistantMessage, Message, Model} from "@earendil-works/pi-ai";
import type {ChatBindingEntry} from "../src/storage-schema/overseer-storage";

const user: AiChatAuthorInfo = {type: "user", id: "user", name: "User"};
const agent: AiChatAuthorInfo = {type: "agent", id: "model", name: "Agent"};

// A batch's code change: sets one file of gadget 1.
function codeChange(content: string, filename = "file.js"): CodeChange {
  return {1: [[filename, {set: content}]]};
}

// The files a composed change produces, naming which batches were folded into it.
function filesIn(composed: CodeChange | undefined): string[] {
  if (composed === undefined) return [];
  let content = applyCodeChange(new Map(), composed);
  return [...(content.get(1)?.keys() ?? [])].toSorted();
}

function record(
    sequence: number, author: AiChatAuthorInfo, body: AiChatMessageBody): AiChatMessage {
  return {chatId: 1, sequence, timestamp: new Date(sequence), author, ...body};
}

function message(sequence: number, author: AiChatAuthorInfo, text: string): AiChatMessage {
  return record(sequence, author, {type: "message", message: text});
}

// Provenance fields for synthesized pi assistant messages (only api/provider/id are read).
const testModel = {
  id: "test-model", api: "anthropic-messages", provider: "anthropic",
} as Model<Api>;

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function projection(messages: AiChatMessage[]) {
  return messages.flatMap(entry => entry.type === "message" ? [{
    message: entry.author.type === "agent"
        ? assistantMessage([{type: "text", text: entry.message}])
        : {role: "user" as const, content: entry.message, timestamp: 0},
    sequence: entry.sequence,
    canCut: true,
  }] : []);
}

// Reduces a summary-prompt message to its role + flattened text, hiding the pi bookkeeping
// fields (usage, timestamps, ...) that don't matter to these tests.
function promptText(message: Message): {role: string, text: string} {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      text: message.content.map(block => block.type === "text" ? block.text : "").join(""),
    };
  }
  return {role: message.role, text: `${message.content}`};
}

const initialBindings: [string, ChatBindingEntry][] = [
  ["APP", {type: "workpiece", id: 1}],
];

function buildState(messages: AiChatMessage[], compactedTo: number) {
  return buildCompactionState(messages, compactedTo, initialBindings, undefined);
}

describe("compaction trigger", () => {
  it("triggers at 85 percent of the input budget", () => {
    expect(shouldCompactChat(84_999, 100_000)).toBe(false);
    expect(shouldCompactChat(85_000, 100_000)).toBe(true);
  });

  it("reserves output capacity only where the model counts it against its own window", () => {
    // Workers AI charges the response to the window, so it has to be withheld.
    expect(getModelTokenLimits({
      provider: "cloudflare", model: "@cf/moonshotai/kimi-k2.7-code", apiToken: "",
    })).toEqual({inputBudget: 229_376, maxOutputTokens: 32_768});

    // Anthropic publishes an input-only window, so withholding anything would waste it.
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-opus-5-5", apiToken: "",
    })).toEqual({inputBudget: 1_000_000, maxOutputTokens: undefined});
  });

  it("uses the suggested 272K compaction budget for GPT-5.6 and GPT-6", () => {
    for (let model of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      expect(getModelTokenLimits({provider: "openai", model, apiToken: ""}))
          .toEqual({inputBudget: 272_000, maxOutputTokens: 128_000});
    }
    for (let model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]) {
      expect(getModelTokenLimits({provider: "openai", model, apiToken: ""}))
          .toEqual({inputBudget: 272_000, maxOutputTokens: 128_000});
    }
  });

  // Workers AI rejects a request whose prompt and response cap together exceed the window, so a
  // Cloudflare model configured by hand needs the reservation the model table can't declare for it.
  it("reserves Workers AI output capacity for a model the registry doesn't list", () => {
    expect(getModelTokenLimits({provider: "cloudflare", model: "@cf/custom", apiToken: ""}))
        .toEqual({inputBudget: 95_232, maxOutputTokens: 32_768});

    // Other providers fall back to the assumed window with nothing withheld.
    expect(getModelTokenLimits({provider: "ollama", model: "local", apiToken: ""}))
        .toEqual({inputBudget: 128_000, maxOutputTokens: undefined});
  });

  it("lets the model config override the window and output limit", () => {
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-unlisted", apiToken: "",
      contextWindow: 1_000_000, outputLimit: 64_000,
    })).toEqual({inputBudget: 936_000, maxOutputTokens: 64_000});

    // An override beats the model table, too.
    expect(getModelTokenLimits({
      provider: "cloudflare", model: "@cf/moonshotai/kimi-k2.7-code", apiToken: "",
      outputLimit: 16_384,
    })).toEqual({inputBudget: 245_760, maxOutputTokens: 16_384});
  });

  it("takes the config's compaction budget ahead of the model's own", () => {
    let gpt = {provider: "openai" as const, model: "gpt-6-sol", apiToken: ""};
    // Below the suggested 272K, and above it.
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 100_000}))
        .toEqual({inputBudget: 100_000, maxOutputTokens: 128_000});
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 500_000}))
        .toEqual({inputBudget: 500_000, maxOutputTokens: 128_000});

    // A model that declares no budget of its own sizes against its window.
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-opus-5-5", apiToken: "", compactionInputBudget: 200_000,
    })).toEqual({inputBudget: 200_000, maxOutputTokens: undefined});

    // Absent and undefined are the same.
    expect(getModelTokenLimits({...gpt, compactionInputBudget: undefined}))
        .toEqual(getModelTokenLimits(gpt));
  });

  it("caps the config's compaction budget at what the window leaves for a prompt", () => {
    // 1,050,000 less the 128,000 reserved for the response.
    let gpt = {provider: "openai" as const, model: "gpt-6-sol", apiToken: ""};
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 922_000}).inputBudget)
        .toBe(922_000);
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 922_001}).inputBudget)
        .toBe(922_000);
    expect(getModelTokenLimits({...gpt, compactionInputBudget: Infinity}).inputBudget)
        .toBe(922_000);

    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-opus-5-5", apiToken: "",
      compactionInputBudget: 2_000_000,
    }).inputBudget).toBe(1_000_000);
    expect(getModelTokenLimits({
      provider: "cloudflare", model: "@cf/moonshotai/kimi-k2.7-code", apiToken: "",
      compactionInputBudget: 262_144,
    })).toEqual({inputBudget: 229_376, maxOutputTokens: 32_768});

    // The config's own window and output limit decide the room.
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-unlisted", apiToken: "",
      contextWindow: 100_000, outputLimit: 20_000, compactionInputBudget: 90_000,
    }).inputBudget).toBe(80_000);
  });

  it("recognizes /compact as the newest message, and only there", () => {
    let compact = record(1, user, {
      type: "slashCommand", request: {id: {builtin: true, commandId: "compact"}, args: ""},
    });
    expect(isCompactionTurn([message(0, user, "hi"), compact])).toBe(true);
    expect(isCompactionTurn([compact, message(2, user, "hi")])).toBe(false);
    expect(isCompactionTurn([message(0, user, "hi")])).toBe(false);
  });

  // Every one of these produces a `user` model message, so retained context can begin at it. A chat
  // driven only by callbacks would otherwise never find a cut point.
  it("treats callbacks, nudges and accepted connections as turn starts", () => {
    expect(startsAgentTurn(message(0, user, "hi"))).toBe(true);
    expect(startsAgentTurn(message(0, agent, "reply"))).toBe(false);
    expect(startsAgentTurn(record(0, agent, {
      type: "agentCallback", methodName: "run", argsSummary: "", initiatorModelId: "m",
    }))).toBe(true);
    expect(startsAgentTurn(record(0, agent, {type: "agentNudge", text: "continue"}))).toBe(true);
    expect(startsAgentTurn(record(0, agent, {
      type: "connectionRequest", requestId: "1:1", vendorId: "v", vendorName: "V",
      reason: "Needed", state: "accepted",
    }))).toBe(true);
    expect(startsAgentTurn(record(0, agent, {
      type: "connectionRequest", requestId: "1:1", vendorId: "v", vendorName: "V",
      reason: "Needed", state: "pending",
    }))).toBe(false);
  });
});

describe("compaction boundary", () => {
  // An explicit `/compact` on a short chat has no budget pressure to cut against. It summarizes
  // everything but the newest record rather than refusing, because the user asked for it.
  it("compacts a conversation already below the target size", () => {
    let messages = [
      message(0, user, "first request"),
      message(1, agent, "first response"),
      message(2, user, "follow-up"),
      message(3, agent, "second response"),
    ];

    expect(findCompactionBoundary(projection(messages), 100_000, 20_000)).toBe(3);

    // Under budget pressure the walk picks the cut instead, leaving roughly the target in the tail.
    expect(findCompactionBoundary(projection(messages), 100_000, 40_000)).toBe(1);
  });

  // The checkpoint records provisional creations, so unlike a pending connection request they need
  // no protection and the boundary may pass them.
  it("protects a pending connection request but not a provisional creation", () => {
    let creation = [
      message(0, user, "create it"),
      record(1, agent, {
        type: "changes", createdGadgets: [{gadgetId: 2, title: "New", bindingName: "NEW"}],
      }),
      message(2, user, "continue"),
    ];
    expect(findProtectedFromSequence(creation)).toBeUndefined();

    let pending: AiChatMessage[] = [
      message(0, user, "hi"),
      message(1, user, "connect"),
      record(2, agent, {
        type: "connectionRequest", requestId: "1:1", vendorId: "v", vendorName: "V",
        reason: "Needed", state: "pending",
      }),
    ];
    expect(findProtectedFromSequence(pending)).toBe(1);
  });

  it("keeps complete recent turns within the 30 percent target", () => {
    let messages = [
      message(0, user, "a".repeat(40_000)),
      message(1, agent, "b".repeat(40_000)),
      message(2, user, "c".repeat(40_000)),
      message(3, agent, "d".repeat(40_000)),
      message(4, user, "e".repeat(40_000)),
      message(5, agent, "f".repeat(40_000)),
    ];

    // Exclusive: everything below 4 is summarized, so the last turn is retained whole.
    expect(findCompactionBoundary(projection(messages), 100_000, 120_000)).toBe(4);
  });

  it("stops the boundary short of a pending connection request", () => {
    let messages: AiChatMessage[] = [
      message(0, user, "hi"),
      record(1, agent, {
        type: "connectionRequest", requestId: "1:1", vendorId: "vendor", vendorName: "Vendor",
        reason: "Needed", state: "pending",
      }),
      message(2, user, "a".repeat(240_000)),
      message(3, agent, "b".repeat(240_000)),
      message(4, user, "next"),
      message(5, agent, "done"),
    ];

    // Without the limit the pending request would move into the summary.
    expect(findCompactionBoundary(projection(messages), 100_000, 120_000, 0, 1)).toBe(1);
  });

  it("refuses when the only cut available is the existing boundary", () => {
    let messages: AiChatMessage[] = [
      message(0, user, "a".repeat(40_000)),
      message(1, agent, "b".repeat(40_000)),
      record(2, agent, {
        type: "connectionRequest", requestId: "1:1", vendorId: "vendor", vendorName: "Vendor",
        reason: "Needed", state: "pending",
      }),
      message(3, user, "c".repeat(40_000)),
      message(4, agent, "d".repeat(40_000)),
    ];

    expect(findCompactionBoundary(projection(messages), 100_000, 120_000, 0, 0)).toBeUndefined();
  });

  // One record can fill the whole budget, which walks the cut scan off the front. Falling back to
  // the newest cut keeps the thread compactable.
  it("falls back to the newest record when one record exceeds the budget", () => {
    let messages = [
      message(0, user, "latest".repeat(30_000)),
      message(1, agent, "reply".repeat(30_000)),
    ];
    expect(findCompactionBoundary(projection(messages), 100, 120_000)).toBe(1);

    let withEarlier = [message(0, user, "hi"), message(1, agent, "ok"), ...messages.map(
      entry => ({...entry, sequence: entry.sequence + 2}))];
    expect(findCompactionBoundary(projection(withEarlier), 100, 120_000)).toBe(3);
  });

  // A repeated compaction whose budget cut lands on the turn right after the previous boundary
  // would otherwise refuse forever, leaving the thread permanently over the window.
  it("falls back rather than refusing when the budget cut cannot advance", () => {
    let projected = [
      {message: {role: "user" as const, content: "prior summary"}},
      ...projection([
        message(4, user, "a".repeat(60_000)),
        message(5, agent, "b".repeat(60_000)),
        message(6, user, "c"),
        message(7, agent, "d"),
      ]),
    ];

    expect(findCompactionBoundary(projected, 100_000, 120_000, 5)).toBe(7);
  });
});

describe("compaction checkpoint state", () => {
  it("folds only non-regenerable replay state into the checkpoint", () => {
    let messages: AiChatMessage[] = [
      {
        ...message(0, user, "Use this"),
        capsules: [{
          position: 4, length: 4, gatekeeperId: 7,
          bindingName: "DOCS",
          description: {url: "https://example.com", title: "Resource", snippet: "Resource"},
        }],
      },
      {
        ...message(1, agent, "Read it"),
        toolCalls: [{
          toolCallId: "call_1", toolName: "readFile",
          input: {workpiece: "APP", filename: "server.js"},
        }],
      },
      record(2, agent, {type: "changes", change: codeChange("a")}),
    ];

    let state = buildState(messages, 3);
    expect(state.chatBindings).toEqual([
      ["APP", {type: "workpiece", id: 1}],
      ["DOCS", {type: "workpiece", id: 7}],
    ]);
    expect(state.nextChangeId).toBe(1);
    expect(state.proposedChange).toBeDefined();
  });

  // Accepted changes live in commits from their epoch-closing merge on, so the checkpoint
  // carries only the still-proposed composition.
  it("drops accepted changes, composing only still-proposed ones", () => {
    let messages: AiChatMessage[] = [
      record(0, agent, {type: "changes", change: codeChange("a", "accepted.js")}),
      record(1, agent, {type: "changes", change: codeChange("b", "proposed.js")}),
      record(2, user, {type: "merge", mergeThrough: 0, commits: [], epochBoundary: true}),
    ];

    let state = buildState(messages, 3);
    expect(filesIn(state.proposedChange)).toEqual(["proposed.js"]);
  });

  it("keeps a change merged at the boundary sequence when a later revert lands", () => {
    let messages: AiChatMessage[] = [
      record(0, agent, {type: "changes", change: codeChange("a")}),
      record(1, user, {type: "merge", mergeThrough: 0, version: 2, commits: []}),
      record(2, user, {type: "revert", revertFrom: 0}),
    ];

    let state = buildState(messages, 3);
    expect(state.proposedChange).toBeUndefined();
  });

  // A creation-only batch leaves no Y.Doc update, so the checkpoint has nothing to carry for it --
  // the registry row it created is what records it. The binding name still has to reach replay,
  // since retained messages refer to it as `env.NEW`.
  it("keeps a provisional creation's binding name without inventing an update", () => {
    let state = buildState([
      record(0, agent, {
        type: "changes",
        createdGadgets: [{gadgetId: 2, title: "New", bindingName: "NEW"}],
        addedBindings: [{gadgetId: 2, name: "DB", target: 9}],
      }),
    ], 1);

    expect(state.chatBindings).toContainEqual(["NEW", {type: "workpiece", id: 2}]);
    expect(state.proposedChange).toBeUndefined();
    // It still counts as a batch, so change IDs stay sequential across the boundary.
    expect(state.nextChangeId).toBe(1);
  });

  // A delivered call's arguments stay reachable under the name stamped on its message; a message
  // from before calls were durable carries no name, and its arguments are gone.
  it("binds a delivered call's arguments by the name stamped on it, and a legacy call not at all",
      () => {
    let state = buildState([
      record(0, agent, {
        type: "agentCallback", methodName: "run", argsSummary: "[0]: 1", bindingName: "run_ARGS",
      }),
      record(1, agent, {type: "agentCallback", methodName: "run", argsSummary: "[0]: 2"}),
    ], 2);

    expect(state.chatBindings).toEqual([
      ["APP", {type: "workpiece", id: 1}],
      ["run_ARGS", {type: "value", messageSequence: 0}],
    ]);
  });

  it("carries a previous checkpoint's proposed state forward", () => {
    let previous = {
      chatId: 1, compactedTo: 3, summary: "earlier",
      ...buildState([record(0, agent, {type: "changes", change: codeChange("a")})], 1),
    };

    let next = buildCompactionState(
        [message(3, user, "more"), record(4, agent, {type: "changes", change: codeChange("b")})],
        5, initialBindings, previous);
    expect(next.proposedChange).toBeDefined();
    expect(next.nextChangeId).toBe(2);
  });

  // A merge in the new span must accept the carried-forward prefix too, not just this span's own
  // batches, since the prefix sits below every sequence here.
  it("accepts a carried-forward prefix when a later merge covers it", () => {
    let previous = {
      chatId: 1, compactedTo: 2, summary: "earlier",
      ...buildState([record(0, agent, {type: "changes", change: codeChange("a")})], 1),
    };

    let next = buildCompactionState(
        [record(2, user, {type: "merge", mergeThrough: 2, commits: [], epochBoundary: true})],
        3, initialBindings, previous);
    expect(next.proposedChange).toBeUndefined();
  });

  const pin7 = {gadgetId: 7, baseCommit: "a".repeat(40)};
  const pin9 = {gadgetId: 9, baseCommit: "b".repeat(40)};

  it("records the pins active at the boundary, dropping reverted declarations", () => {
    let state = buildState([
      record(0, agent, {type: "changes", change: codeChange("a"), pins: [pin7]}),
      record(1, agent, {type: "changes", change: codeChange("b"), pins: [pin9]}),
      record(2, user, {type: "revert", revertFrom: 1}),
    ], 3);

    expect(state.pins).toEqual([pin7]);
    expect(state.epoch).toBeUndefined();
  });

  // A revert recorded after the boundary reaches the changes before it: compaction cuts between
  // the two, and a revert refolds the checkpoints it reaches.
  it("drops the changes and pins a revert after the boundary discarded", () => {
    let state = buildState([
      record(0, agent, {type: "changes", change: codeChange("a", "kept.js"), pins: [pin7]}),
      record(1, agent, {type: "changes", change: codeChange("b", "reverted.js"), pins: [pin9]}),
      message(2, user, "Undo that."),
      record(3, user, {type: "revert", revertFrom: 1}),
    ], 2);

    expect(filesIn(state.proposedChange)).toEqual(["kept.js"]);
    expect(state.pins).toEqual([pin7]);
  });

  // Replay applies a later merge to the whole checkpoint; until it does, retained messages still
  // see the proposed changes.
  it("leaves a merge after the boundary to replay", () => {
    let state = buildState([
      record(0, agent, {type: "changes", change: codeChange("a")}),
      message(1, user, "Ship it."),
      record(2, user, {type: "merge", mergeThrough: 1, commits: [], epochBoundary: true}),
    ], 1);

    expect(filesIn(state.proposedChange)).toEqual(["file.js"]);
  });

  it("resets pins at an epoch boundary, recording the epoch", () => {
    let previous = {
      chatId: 1, compactedTo: 1, summary: "earlier",
      ...buildState(
          [record(0, agent, {type: "changes", change: codeChange("a"), pins: [pin7]})], 1),
    };
    expect(previous.pins).toEqual([pin7]);

    let next = buildCompactionState([
      record(1, user, {
        type: "merge", mergeThrough: 1, commits: [{gadgetId: 7, commitId: "c".repeat(40)}],
        epochBoundary: true,
      }),
      record(2, agent, {type: "changes", change: codeChange("b"), pins: [pin9]}),
    ], 3, initialBindings, previous);

    expect(next.pins).toEqual([pin9]);
    expect(next.epoch).toBe(1);
    expect(filesIn(next.proposedChange)).toEqual(["file.js"]);
  });

  it("an empty conversion boundary proposes nothing; one with a change is a normal batch", () => {
    // A read-only migrated chat's boundary (no change, no pins) must not surface as a proposed
    // change, while a boundary carrying converted content is an ordinary batch that merges and
    // reverts like any other.
    expect(foldProposedChanges([
      record(0, user, {type: "changes", conversionBoundary: true}),
    ])).toEqual([]);
    let proposed = foldProposedChanges([
      record(0, user, {type: "changes", conversionBoundary: true, change: codeChange("a")}),
    ]);
    expect(proposed.map(batch => batch.sequence)).toEqual([0]);
  });

  it("drops a re-rooted gadget's earlier changes, the previous checkpoint's included", () => {
    // Gadget 1 is edited in two batches either side of a checkpoint, then re-rooted at a merge
    // commit; gadget 2's edit is untouched by the re-root. The re-root's declaration keeps the
    // head it merged.
    let other: CodeChange = {2: [["other.js", {set: "other"}]]};
    let previous = {
      chatId: 1, compactedTo: 1, summary: "earlier",
      ...buildState([record(0, agent, {
        type: "changes", change: {...codeChange("a", "first.js"), ...other}, pins: [pin7],
      })], 1),
    };
    let reroot = {gadgetId: 1, baseCommit: "c".repeat(40), mergedCommit: "d".repeat(40)};

    let next = buildCompactionState([
      record(1, agent, {type: "changes", change: codeChange("b", "second.js")}),
      record(2, user, {type: "changes", pins: [reroot], mainlineMerge: {conflictPaths: []}}),
      record(3, agent, {type: "changes", change: codeChange("c", "third.js")}),
    ], 4, initialBindings, previous);

    expect(next.pins).toEqual([pin7, reroot]);
    expect(filesIn(next.proposedChange)).toEqual(["third.js"]);
    expect(next.proposedChange![2]).toEqual(other[2]);

    // With nothing recorded since, the re-root leaves no change at all, never an empty one.
    let rootedOnly = buildCompactionState([
      record(1, user, {type: "changes", pins: [reroot], mainlineMerge: {conflictPaths: []}}),
    ], 2, initialBindings, {
      chatId: 1, compactedTo: 1, summary: "earlier",
      ...buildState([record(0, agent, {type: "changes", change: codeChange("a"), pins: [pin7]})],
                    1),
    });
    expect(rootedOnly.proposedChange).toBeUndefined();

    // A reverted re-root declares nothing, so the changes before it survive.
    let reverted = buildState([
      record(0, agent, {type: "changes", change: codeChange("a", "first.js"), pins: [pin7]}),
      record(1, user, {type: "changes", pins: [reroot], mainlineMerge: {conflictPaths: []}}),
      record(2, user, {type: "revert", revertFrom: 1}),
    ], 3);
    expect(reverted.pins).toEqual([pin7]);
    expect(filesIn(reverted.proposedChange)).toEqual(["first.js"]);
  });

  it("treats a conversion boundary as an epoch boundary for pins and the epoch", () => {
    // A migrated chat's conversionBoundary changes message re-seeds the content at (pin bases +
    // its change), so a checkpoint past one records the boundary as the epoch and only pins
    // established at or after it.
    let state = buildState([
      record(0, agent, {type: "changes", change: codeChange("a"), pins: [pin7]}),
      record(1, user,
             {type: "changes", change: codeChange("b"), pins: [pin9], conversionBoundary: true}),
    ], 2);

    expect(state.pins).toEqual([pin9]);
    expect(state.epoch).toBe(1);
  });
});

describe("summary prompt", () => {
  // The summarizer declares no tools, and providers reject tool blocks in that case.
  it("flattens to text, merges adjacent roles, and stops at the boundary", () => {
    let prompt = buildSummaryPrompt([
      {message: {role: "user", content: "earlier summary", timestamp: 0}},
      {message: {role: "user", content: "compacted", timestamp: 0}, sequence: 3},
      {
        message: assistantMessage([
          {type: "text", text: "working"},
          {type: "toolCall", id: "c1", name: "readFile", arguments: {a: 1}},
        ]),
        sequence: 4,
      },
      {message: {role: "user", content: "retained", timestamp: 0}, sequence: 6},
    ], 6, testModel);

    expect(prompt.map(promptText)).toEqual([
      {role: "user", text: "earlier summary\ncompacted"},
      {role: "assistant", text: "working\n[readFile {\"a\":1}]"},
    ]);
  });
});

// The boundary is the first retained sequence, so every bound derived from it is exclusive at the
// bottom. These pin the arithmetic that paging and rollback rely on.
describe("boundary arithmetic", () => {
  it("summarizes strictly below the boundary and retains from it", () => {
    let messages: AiChatMessage[] = [
      record(0, agent, {type: "changes", change: codeChange("a")}),
      record(1, agent, {type: "changes", change: codeChange("b")}),
    ];

    // compactedTo 1 folds sequence 0 only, so one batch is left for the tail to carry.
    expect(buildState(messages, 1).nextChangeId).toBe(1);
    expect(buildState(messages, 2).nextChangeId).toBe(2);
    // Nothing below zero, so a zero boundary folds nothing.
    expect(buildState(messages, 0).nextChangeId).toBe(0);
  });

  it("keeps the summary prompt and the checkpoint agreeing on the boundary", () => {
    let messages = [
      message(0, user, "first"),
      message(1, agent, "reply"),
      message(2, user, "second"),
    ];

    // The message at the boundary belongs to the retained tail, not the summary.
    let prompt = buildSummaryPrompt(projection(messages), 2, testModel);
    expect(prompt.map(promptText)).toEqual([
      {role: "user", text: "first"},
      {role: "assistant", text: "reply"},
    ]);
  });
});
