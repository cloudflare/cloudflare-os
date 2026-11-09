import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

/**
 * The composer's model, or null for "No agent". `name` labels it when `models` doesn't offer it,
 * such as a hidden model an existing chat last ran on; the raw id is shown when that is absent too.
 */
export type SelectedModel = { id: string; name?: string } | null;

/** The label a model choice shows: its listed name, the chat's own name for it, or its id. */
export const modelLabel = (models: readonly AiChatAuthorInfo[], selected: SelectedModel) =>
  selected == null
    ? "No agent"
    : models.find((model) => model.id === selected.id)?.name ?? selected.name ?? selected.id;
