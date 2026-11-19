const trimmed = (value: number, digits: number) => String(Number(value.toFixed(digits)))

/** A number of tokens in a few characters: 842, 83.3K, 124K, 1.2M. */
export const formatTokenCount = (tokens: number) => {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 100_000) return `${trimmed(tokens / 1000, 1)}K`
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}K`
  return `${trimmed(tokens / 1_000_000, 1)}M`
}

/** What a chat has cost, to the fraction of a cent that chats cost: $0.0412. */
export const formatCost = (dollars: number) => (dollars === 0 ? '$0' : `$${dollars.toFixed(4)}`)

/** What a workspace has cost, as a total to read at a glance: $0, <$0.01, $1.23. */
export const formatTotalCost = (dollars: number) => (dollars === 0 ? '$0' : dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`)

/** A cost to the last digit it is kept to, for where there is room to say it. */
export const formatExactCost = (dollars: number) => `$${dollars.toFixed(6)}`

/** How long something took, as a person would say it: 850 ms, 12 s, 2 min 5 s. */
export const formatDuration = (milliseconds: number) => {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`
}
