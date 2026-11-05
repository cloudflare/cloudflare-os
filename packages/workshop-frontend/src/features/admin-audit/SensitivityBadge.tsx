import { Badge } from '@cloudflare/kumo'
import type { AuditSensitivity } from './auditFilter'

/** What the Audit tab calls each sensitivity. */
export const SENSITIVITY_NAMES: Record<AuditSensitivity, string> = {
  content: 'Content read',
  metadata: 'Workspace metadata',
  setting: 'Setting change',
}

const VARIANTS = { content: 'error', metadata: 'neutral', setting: 'outline' } as const

/** A record's sensitivity, as a badge: only a content read's is colored, so content reads stand out. */
export const SensitivityBadge = ({ sensitivity }: { sensitivity: AuditSensitivity }) => (
  <Badge variant={VARIANTS[sensitivity]}>{SENSITIVITY_NAMES[sensitivity]}</Badge>
)
