import { createRoot as createReactRoot, type Root } from 'react-dom/client'
import { I18nProvider } from './I18nProvider'

export type { Root } from 'react-dom/client'

/** Mount isolated UI tests with the same locale boundary as the application. */
export const createRoot = (...args: Parameters<typeof createReactRoot>): Root => {
  const root = createReactRoot(...args)
  return {
    render: children => root.render(<I18nProvider>{children}</I18nProvider>),
    unmount: () => root.unmount(),
  }
}
