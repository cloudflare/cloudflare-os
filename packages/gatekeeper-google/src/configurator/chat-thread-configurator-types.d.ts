export type ChatThreadConfiguratorValues = {
  /** A pasted Chat link to the thread or a message in it, or `spaces/{space}/threads/{thread}`. */
  link?: string | null;
};

/** A pasted link needs no lookup, so the iframe gets no capability. */
export interface ChatThreadConfiguratorRpc {}
