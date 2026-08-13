import { useEffect, useState } from "react";
import type { RpcStub } from "capnweb";
import type { Overseer, SlashCommandChoice, SlashCommandId } from "@gadgets/workshop-shared/api";

/**
 * How a consumer reaches the Overseer. Identity matters: it keys the cache below, and callers
 * already hold it steady for as long as the chat they belong to.
 */
export type OverseerSource = () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;

// The catalog is the same for every consumer in a chat, and both the composer's picker and the
// commands in the transcript want it, so it is fetched once and shared. A failed load is dropped so
// the next caller retries.
const catalogs = new WeakMap<OverseerSource, Promise<SlashCommandChoice[]>>();

export function loadSlashCommandCatalog(source: OverseerSource): Promise<SlashCommandChoice[]> {
  let cached = catalogs.get(source);
  if (cached) return cached;
  let load = Promise.resolve(source())
    .then((overseer) => overseer.listSlashCommands())
    .catch((err) => {
      catalogs.delete(source);
      throw err;
    });
  catalogs.set(source, load);
  return load;
}

/**
 * Identifies a command across providers. A built-in has no Gatekeeper, so it gets its own namespace
 * rather than colliding on an undefined one.
 */
export function slashCommandKey(id: SlashCommandId): string {
  return `${id.builtin === true ? "builtin" : id.gatekeeperId}:${id.commandId}`;
}

/**
 * Looks up a command a message was sent with. Names aren't unique across providers, so this matches
 * on the full id. Resolves to undefined for a command whose provider is gone, which is why callers
 * treat the description as an enhancement rather than something to reserve space for.
 */
export function useSlashCommandChoice(
  source: OverseerSource,
  id: SlashCommandId | undefined,
): SlashCommandChoice | undefined {
  const [resolved, setResolved] = useState<{key: string; choice?: SlashCommandChoice}>();
  const key = id && slashCommandKey(id);

  useEffect(() => {
    if (key === undefined) return;
    let cancelled = false;
    loadSlashCommandCatalog(source)
      .then((catalog) => {
        if (cancelled) return;
        setResolved({key, choice: catalog.find((entry) => slashCommandKey(entry.selection) === key)});
      })
      .catch(() => {
        // A description the user can only reach by hovering isn't worth reporting a failure over.
      });
    return () => {
      cancelled = true;
    };
  }, [key, source]);

  return resolved && resolved.key === key ? resolved.choice : undefined;
}
