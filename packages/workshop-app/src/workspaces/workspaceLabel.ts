/** The two letters shown on a workspace's folder: initials of the first two words, or the first two letters. */
export const workspaceLabel = (title: string) => {
  const words = title.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2)
  return letters.toUpperCase()
}
