/** What a new chat says to whoever is starting it, by their first name: "Hello Ada, what should we do today?" */
export const greeting = (name: string) => {
  const [firstName] = name.trim().split(/\s+/)
  return `Hello${firstName ? ` ${firstName}` : ''}, what should we do today?`
}
