import type { AiChatMetadata } from '@gadgets/workshop-shared/api'

/** What a chat has used so far, as its metadata says, each part absent until the server has measured it. */
export type ChatUsage = {
  /** What the model was given at its last step: what the context holds now. Absent after a compaction until the next step. */
  tokens?: number
  /** Dollars, in all. */
  cost?: number
  /** Of the prompt tokens sent, in all, those the provider read from its cache and wrote to it. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export const NO_USAGE: ChatUsage = {}

export const usageOf = ({ totalTokens, totalCost, cacheReadTokens, cacheWriteTokens }: AiChatMetadata): ChatUsage => ({
  tokens: totalTokens,
  cost: totalCost,
  cacheReadTokens,
  cacheWriteTokens,
})

export const sameUsage = (a: ChatUsage, b: ChatUsage) =>
  a.tokens === b.tokens && a.cost === b.cost && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens
