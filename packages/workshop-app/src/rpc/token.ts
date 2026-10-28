// The same key the existing Workshop frontend uses, so after cutover (same origin) a signed-in user
// stays signed in.
const TOKEN_KEY = 'authToken'

export const readToken = () => localStorage.getItem(TOKEN_KEY)

export const storeToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)

export const clearToken = () => localStorage.removeItem(TOKEN_KEY)
