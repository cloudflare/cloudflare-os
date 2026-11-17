import { Badge } from '@cloudflare/kumo'
import type { AdminAuditKind } from '@gadgets/workshop-shared/api'

/** What the Audit tab calls each kind of record. */
export const KIND_NAMES: Record<AdminAuditKind, string> = {
  workspace: 'Workspace access',
  user: 'User access',
  setting: 'Setting change',
}

const VARIANTS = { workspace: 'neutral', user: 'neutral', setting: 'outline' } as const

/** A record's kind, as a badge. */
export const KindBadge = ({ kind }: { kind: AdminAuditKind }) => (
  <Badge variant={VARIANTS[kind]}>{KIND_NAMES[kind]}</Badge>
)
