/**
 * What a new chat says to whoever is starting it, by their first name, and by what it is started
 * beside when it is: "Hello Ada, what should we do today?", "Hello Ada, what should we do with Slides?"
 */
export const greeting = (name: string, about?: string) => {
  const [firstName] = name.trim().split(/\s+/)
  return `Hello${firstName ? ` ${firstName}` : ''}, what should we do ${about ? `with ${about}` : 'today'}?`
}
