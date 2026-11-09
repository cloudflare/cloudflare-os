import { Badge } from '@cloudflare/kumo'
import type { AuditSensitivity } from './auditFilter'

/** What the Audit tab calls each sensitivity. */
export const SENSITIVITY_NAMES: Record<AuditSensitivity, string> = {
  write: 'Workspace write',
  content: 'Content read',
  metadata: 'Workspace metadata',
  setting: 'Setting change',
}

const VARIANTS = { write: 'orange', content: 'error', metadata: 'neutral', setting: 'outline' } as const

/** A record's sensitivity, as a badge: only a write's and a content read's are colored, so both stand out. */
export const SensitivityBadge = ({ sensitivity }: { sensitivity: AuditSensitivity }) => (
  <Badge variant={VARIANTS[sensitivity]}>{SENSITIVITY_NAMES[sensitivity]}</Badge>
)
