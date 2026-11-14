import { Connection, defaultApiUrl } from './Connection'

let instance: Connection | undefined

/** The app's one backend connection, opened the first time something needs it. */
export const sharedConnection = () => (instance ??= new Connection(defaultApiUrl()))
