/**
 * What a new chat says to whoever is starting it, by their display name, and by what it is started
 * beside when it is: "Hello Ada Lovelace, what should we do today?", "Hello Ada Lovelace, what should we do with Slides?"
 */
export const greeting = (name: string, about?: string) => {
  const displayName = name.trim().replace(/\s+/g, ' ')
  return `Hello${displayName ? ` ${displayName}` : ''}, what should we do ${about ? `with ${about}` : 'today'}?`
}
