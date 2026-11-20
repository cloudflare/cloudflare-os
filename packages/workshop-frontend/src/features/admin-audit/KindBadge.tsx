import { Badge } from '@cloudflare/kumo'
import type { AdminAuditKind } from '@gadgets/workshop-shared/api'

/** What the Audit tab calls each kind of record. */
export const KIND_NAMES: Record<AdminAuditKind, string> = {
  workspace: 'Workspace access',
  user: 'User access',
  write: 'Workspace write',
  grant: 'Content grant',
  setting: 'Setting change',
}

const VARIANTS = {
  workspace: 'neutral', user: 'neutral', write: 'orange', grant: 'orange', setting: 'outline',
} as const

/** A record's kind, as a badge: only a write's and a grant step's are colored, so they stand
 * out. */
export const KindBadge = ({ kind }: { kind: AdminAuditKind }) => (
  <Badge variant={VARIANTS[kind]}>{KIND_NAMES[kind]}</Badge>
)
