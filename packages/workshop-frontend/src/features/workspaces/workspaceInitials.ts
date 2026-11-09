/**
 * The two letters on a workspace's folder badge. The design takes the first two letters of the
 * title ("Engineering" is "EN", "Workspace 1" is "WO"), skipping anything that isn't a letter or
 * digit so emoji and punctuation don't produce an unreadable badge.
 */
export const workspaceInitials = (title: string): string => {
  const letters = [...title.normalize('NFC')].filter(ch => /[\p{L}\p{N}]/u.test(ch))
  return letters.slice(0, 2).join('').toLocaleUpperCase() || '··'
}
