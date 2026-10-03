import type { RpcStub } from "capnweb";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { describe, expect, it, vi } from "vitest";
import {
  invalidateSlashCommandCatalog,
  loadSlashCommandCatalog,
  type OverseerSource,
} from "./slash-command-catalog";

describe("slash command catalog", () => {
  it("does not let a stale rejection evict a replacement load", async () => {
    let rejectStale!: (error: Error) => void;
    const choice = {
      selection: { gatekeeperId: 1, commandId: "review" },
      name: "review",
      description: "Review a draft.",
      providerLabel: "Writing tools",
    } satisfies SlashCommandChoice;
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectStale = reject;
      }))
      .mockResolvedValueOnce([choice]);
    const source: OverseerSource = () => ({
      listSlashCommands,
    } as unknown as RpcStub<Overseer>);

    const stale = loadSlashCommandCatalog(source).catch((error) => error);
    invalidateSlashCommandCatalog(source);
    const replacement = loadSlashCommandCatalog(source);
    await vi.waitFor(() => expect(listSlashCommands).toHaveBeenCalledTimes(2));

    rejectStale(new Error("stale failure"));
    await stale;

    expect(loadSlashCommandCatalog(source)).toBe(replacement);
    await expect(replacement).resolves.toEqual([choice]);
    expect(listSlashCommands).toHaveBeenCalledTimes(2);
  });
});
