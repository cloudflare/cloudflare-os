import { stored } from './stored'

const store = stored<string>('workshop-app:dismissed-banner', (value) => (typeof value === 'string' ? value : undefined), '')

/**
 * The text of the deployment's banner that was last put away on this device, which stays away
 * until the banner says something else.
 */
export const readDismissedBanner = () => store.read()

export const writeDismissedBanner = (text: string) => store.write(text)
