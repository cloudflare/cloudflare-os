import type { AiChatMetadata } from '@gadgets/workshop-shared/api'

/** What a chat has used so far, as its metadata says, each part absent until the server has measured it. */
export type ChatUsage = {
  /**
   * How full the context was at the last step, against the budget the chat compacts at on the model
   * it ran on: what the context holds now. Absent after a compaction until the next step.
   */
  context?: { tokens: number; budget: number; model: string }
  /** Dollars, in all. */
  cost?: number
  /** Of the prompt tokens sent, in all, those the provider read from its cache and wrote to it. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export const NO_USAGE: ChatUsage = {}

export const usageOf = ({ totalTokens, contextBudget, totalCost, cacheReadTokens, cacheWriteTokens }: AiChatMetadata): ChatUsage => ({
  context: totalTokens !== undefined && contextBudget ? { tokens: totalTokens, budget: contextBudget.tokens, model: contextBudget.model } : undefined,
  cost: totalCost,
  cacheReadTokens,
  cacheWriteTokens,
})

export const sameUsage = (a: ChatUsage, b: ChatUsage) =>
  a.context?.tokens === b.context?.tokens && a.context?.budget === b.context?.budget && a.context?.model === b.context?.model &&
  a.cost === b.cost && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens
