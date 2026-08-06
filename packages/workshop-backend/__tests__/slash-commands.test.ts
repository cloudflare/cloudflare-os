import {describe, expect, it, vi} from "vite-plus/test";
import type {
  SlashCommandDescriptor, SlashCommandResult,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  collectSlashCommands, invokeSlashCommand,
} from "../src/slash-commands";

function rpcPromise<T>(promise: Promise<T>, onDispose?: () => void): Promise<T> & Disposable {
  return Object.assign(promise, {[Symbol.dispose]() { onDispose?.(); }});
}

function gatekeeper(options: {
  commands?: () => SlashCommandDescriptor[] | Promise<SlashCommandDescriptor[]>;
  invoke?: (id: string, message: string, authorizer: unknown) =>
      SlashCommandResult | Promise<SlashCommandResult>;
  failList?: boolean;
  onList?: () => void;
  onDispose?: () => void;
}) {
  return {
    getSlashCommandProvider() {
      let provider = {
        async list() {
          options.onList?.();
          if (options.failList) throw new Error("list failed");
          return options.commands?.() ?? [];
        },
        async invoke(id: string, message: string, authorizer: unknown) {
          return options.invoke
            ? options.invoke(id, message, authorizer)
            : {message: id};
        },
        [Symbol.dispose]() {
          options.onDispose?.();
        },
      };
      return rpcPromise(Promise.resolve(provider), () => provider[Symbol.dispose]());
    },
  };
}

function source(
    id: number, providerLabel: string, value: object,
): Parameters<typeof collectSlashCommands>[0][number] {
  return {gatekeeperId: id, providerLabel, gatekeeper: value as never};
}

const deploy: SlashCommandDescriptor = {
  id: "deploy",
  name: "deploy",
  description: "Deploy the current project.",
};

const review: SlashCommandDescriptor = {
  id: "review",
  name: "review",
  description: "Review a change.",
  resourceLabel: "PRs",
};

describe("slash command helpers", () => {
  it("combines and sorts provider catalogs", async () => {
    let lists = vi.fn();
    let sources = [
      source(2, "Zebra", gatekeeper({commands: () => [{...deploy, id: "z-deploy"}]})),
      source(1, "Alpha", gatekeeper({commands: () => [review, deploy], onList: lists})),
    ];

    await expect(collectSlashCommands(sources)).resolves.toMatchObject([
      {name: "deploy", providerLabel: "Alpha", selection: {commandId: "deploy"}},
      {name: "deploy", providerLabel: "Zebra", selection: {commandId: "z-deploy"}},
      {name: "review", providerLabel: "Alpha", resourceLabel: "PRs"},
    ]);
    expect(lists).toHaveBeenCalledTimes(1);
  });

  it("isolates a provider catalog failure", async () => {
    let sources = [
      source(1, "Context", gatekeeper({commands: () => [deploy]})),
      source(2, "Broken", gatekeeper({failList: true})),
    ];
    await expect(collectSlashCommands(sources)).resolves.toMatchObject([
      {selection: {gatekeeperId: 1, commandId: "deploy"}},
    ]);
  });

  it("performs a fresh fanout on each catalog request", async () => {
    let commands = [deploy];
    let lists = vi.fn();
    let sources = [source(1, "Context", gatekeeper({commands: () => commands, onList: lists}))];
    await collectSlashCommands(sources);
    commands = [review];
    await expect(collectSlashCommands(sources)).resolves.toMatchObject([{name: "review"}]);
    expect(lists).toHaveBeenCalledTimes(2);
  });

  it("forwards arguments and keeps the provider alive until invocation completes", async () => {
    let release!: (result: SlashCommandResult) => void;
    let invoked = vi.fn((_id: string, _message: string, _authorizer: unknown) =>
      new Promise<SlashCommandResult>(resolve => { release = resolve; }));
    let disposals = vi.fn();
    let value = gatekeeper({invoke: invoked, onDispose: disposals});
    let authorizer = {};
    let request = {
      id: {gatekeeperId: 1, commandId: "deploy"},
      args: "prod now",
    };

    let result = invokeSlashCommand(value as never, request, authorizer as never);
    await vi.waitFor(() => expect(invoked).toHaveBeenCalled());
    expect(disposals).not.toHaveBeenCalled();
    release({skillName: "deploy", message: "Deploy production."});
    await expect(result).resolves.toEqual({skillName: "deploy", message: "Deploy production."});
    expect(invoked).toHaveBeenCalledWith("deploy", "prod now", authorizer);
    expect(disposals).toHaveBeenCalledTimes(1);
  });

  it("keeps the provider alive until listing completes", async () => {
    let release!: (commands: SlashCommandDescriptor[]) => void;
    let disposals = vi.fn();
    let sources = [source(1, "Context", gatekeeper({
      commands: () => new Promise(resolve => { release = resolve; }),
      onDispose: disposals,
    }))];

    let result = collectSlashCommands(sources);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(disposals).not.toHaveBeenCalled();
    release([deploy]);
    await expect(result).resolves.toHaveLength(1);
    expect(disposals).toHaveBeenCalledTimes(1);
  });
});
