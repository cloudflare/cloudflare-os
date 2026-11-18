import type { ElementType } from 'react'
import { BriefcaseIcon, ChartBarIcon, ChatsCircleIcon, CodeIcon, HouseIcon, MegaphoneIcon, SparkleIcon, UsersThreeIcon } from '@phosphor-icons/react'

/** A kind of service, which those that could be connected are listed under, and can be narrowed to. */
export type ServiceCategory = { id: string; label: string; icon: ElementType }

const PRODUCTIVITY: ServiceCategory = { id: 'productivity', label: 'Productivity', icon: BriefcaseIcon }
const COMMUNICATION: ServiceCategory = { id: 'communication', label: 'Communication', icon: ChatsCircleIcon }
const DEVELOPER: ServiceCategory = { id: 'developer', label: 'Developer tools', icon: CodeIcon }
const DATA: ServiceCategory = { id: 'data', label: 'Data and analytics', icon: ChartBarIcon }
const AGENTS: ServiceCategory = { id: 'agents', label: 'Agent tools', icon: SparkleIcon }
const SALES: ServiceCategory = { id: 'sales', label: 'Sales and marketing', icon: MegaphoneIcon }
const SOCIAL: ServiceCategory = { id: 'social', label: 'Social', icon: UsersThreeIcon }
const HOME: ServiceCategory = { id: 'home', label: 'Home and media', icon: HouseIcon }

/** The categories, in the order they are listed in. */
export const SERVICE_CATEGORIES = [PRODUCTIVITY, COMMUNICATION, DEVELOPER, DATA, AGENTS, SALES, SOCIAL, HOME]

// By a service's id, which is its gatekeeper's package name without `gatekeeper-`, with `_` for `-`.
// Each is every kind the service is, the one it is most first: Google is for mail and data too,
// but is listed as for getting work done.
const BY_SERVICE = new Map<string, ServiceCategory[]>([
  ['google', [PRODUCTIVITY, COMMUNICATION, DATA]],
  ['microsoft', [PRODUCTIVITY, COMMUNICATION]],
  ['notion', [PRODUCTIVITY]],
  ['confluence', [PRODUCTIVITY]],
  ['linear', [PRODUCTIVITY, DEVELOPER]],
  ['slack', [COMMUNICATION, PRODUCTIVITY]],
  ['email', [COMMUNICATION]],
  ['x', [SOCIAL, COMMUNICATION]],
  ['github', [DEVELOPER]],
  ['gitlab', [DEVELOPER]],
  ['cloudflare', [DEVELOPER, DATA, AGENTS]],
  ['supabase', [DEVELOPER, DATA]],
  ['mcp', [DEVELOPER, AGENTS]],
  ['mcp_portal', [DEVELOPER, AGENTS]],
  ['context', [AGENTS, PRODUCTIVITY]],
  ['scheduler', [AGENTS, PRODUCTIVITY]],
  ['websearch', [AGENTS]],
  ['container', [AGENTS, DEVELOPER]],
  ['zoominfo', [SALES, DATA]],
  ['homeassistant', [HOME]],
  ['spotify', [HOME]],
  ['pagerduty', [DEVELOPER, COMMUNICATION]],
  ['backstage', [DEVELOPER, PRODUCTIVITY]],
  ['http', [DEVELOPER]],
  ['sentry', [DEVELOPER]],
  ['zinc', [DEVELOPER, DATA]],
  ['release_manager', [DEVELOPER]],
  ['clickhouse', [DATA, DEVELOPER]],
  ['kibana', [DATA, DEVELOPER]],
  ['prometheus', [DATA, DEVELOPER]],
  ['thanos', [DATA, DEVELOPER]],
  ['slo_directory', [DATA, DEVELOPER]],
  ['town_lake', [DATA]],
  ['risk_beacon', [DATA]],
  ['jira', [PRODUCTIVITY, DEVELOPER]],
  ['cf_wiki', [PRODUCTIVITY]],
  ['firstbase', [PRODUCTIVITY]],
  ['oomnitza', [PRODUCTIVITY]],
  ['intune', [PRODUCTIVITY, DEVELOPER]],
  ['ironclad', [PRODUCTIVITY]],
  ['zip', [PRODUCTIVITY]],
  ['zylo', [PRODUCTIVITY, DATA]],
  ['netsuite', [PRODUCTIVITY, DATA]],
  ['salesforce', [SALES, DATA]],
  ['gtmdata', [SALES, DATA]],
  ['lighthouse', [SALES, DATA]],
  ['marketo', [SALES]],
  ['outreach_contact', [SALES]],
  ['swoogo', [SALES]],
  ['canto', [SALES, PRODUCTIVITY]],
  ['arc', [DATA, DEVELOPER]],
  ['jamf', [PRODUCTIVITY, DEVELOPER]],
  ['kyriba', [PRODUCTIVITY, DATA]],
  ['stripe', [DATA, PRODUCTIVITY]],
  ['workday', [PRODUCTIVITY]],
])

/**
 * What kinds of service the one with this id is, the one it is most first, which is what it is
 * listed under; nothing for one that is not known here. A service says nothing of its kind itself
 * (`VendorDescription`), so this says it for those this repository has a gatekeeper for, and for
 * the internal deployment's, and no others: a deployment's own services have no category until a
 * gatekeeper can say its own, which is for the backend to support.
 */
export const serviceCategories = (vendorId: string): ServiceCategory[] => BY_SERVICE.get(vendorId) ?? []

/** The kind of service it is most, which it is listed under. */
export const primaryCategory = (vendorId: string): ServiceCategory | undefined => serviceCategories(vendorId)[0]
