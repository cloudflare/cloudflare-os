import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { TooltipProvider } from '@cloudflare/kumo'
import { ListViewPrefsContext, MotionProvider, provideMotionLevel, watchMotionLevel } from '@gadgets/ui'
import { keepListViewOnDevice } from './prefs/listView'
import { chosenMotionLevel } from './prefs/motion'
import { createRouter } from './router'
import { ErrorBoundary } from './rpc/ErrorBoundary'
import { installErrorReporting, reportIssue } from './rpc/errorReporting'
import './styles.css'

// Before anything else runs, the connection to the backend included, so that nothing is missed.
installErrorReporting()
provideMotionLevel(chosenMotionLevel)
watchMotionLevel()

const router = createRouter()

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportIssue('workshop-app.react-root', error, { handled: false, severity: 'fatal', captureMechanism: 'react' }),
}).render(
  <StrictMode>
    <ErrorBoundary>
      <MotionProvider>
        <ListViewPrefsContext value={keepListViewOnDevice}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </ListViewPrefsContext>
      </MotionProvider>
    </ErrorBoundary>
  </StrictMode>,
)
