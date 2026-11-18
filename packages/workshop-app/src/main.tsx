import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { TooltipProvider } from '@cloudflare/kumo'
import { createRouter } from './router'
import { ErrorBoundary } from './rpc/ErrorBoundary'
import { installErrorReporting, reportIssue } from './rpc/errorReporting'
import './styles.css'

// Before anything else runs, the connection to the backend included, so that nothing is missed.
installErrorReporting()

const router = createRouter()

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportIssue('workshop-app.react-root', error, { handled: false, severity: 'fatal', captureMechanism: 'react' }),
}).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
)
