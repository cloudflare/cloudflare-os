import { useRef, useState } from 'react'
import { ApprovalRules, type ApprovalRule } from '@/blocks/ApprovalRules'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard, SettingsGroup } from '@/blocks/SettingsGroup'
import { SoonSelect } from './SoonControls'

// Asked about every time, which is said the same way on every line.
const ASK = { id: 'ask', label: 'Always ask' }

// What the rules will read like, to start with, until they can be written for real.
const ASK_RULES: ApprovalRule[] = [
  { id: 'send', text: 'Sending anything to someone outside my company', enabled: true },
  { id: 'delete', text: 'Deleting files or messages', enabled: false },
]
const ALLOW_RULES: ApprovalRule[] = [
  { id: 'calendar', text: 'Adding events to my own calendar', enabled: true },
  { id: 'drafts', text: 'Saving an email as a draft', enabled: true },
]

/** Rules that are tried and not kept: they are there to show what they will be like, until they can be written for real. */
const useTriedRules = (start: ApprovalRule[]) => {
  const [rules, setRules] = useState(start)
  // How many were added, which names each: one written again after being removed is another rule.
  const added = useRef(0)
  return {
    rules,
    // The newest last, as a list is added to.
    onAdd: (text: string) => {
      const id = `added-${(added.current += 1)}`
      setRules((current) => [...current, { id, text, enabled: true }])
    },
    onRemove: (id: string) => setRules((current) => current.filter((rule) => rule.id !== id)),
    onEnabledChange: (id: string, enabled: boolean) => setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, enabled } : rule))),
  }
}

/**
 * What the assistant does without asking the user first, for every workspace: a line for each
 * thing that could wait for them, set the same way, and under those the rules written in their
 * own words, by what they say: what is always asked about, and what is allowed without asking.
 * Each says how strong it is: a rule to ask beats everything, a rule to allow beats the lines
 * above it, and those are what holds where no rule does. What a line cannot be set for (it only
 * says "Always ask") no rule allows either. None of it can be set yet: the backend keeps what is approved without asking
 * by the workspace (`Overseer.setAutoApprovedActionKind`), which a workspace's own settings are
 * for, and has nothing that holds for them all.
 */
export const ApprovalSettings = () => {
  const ask = useTriedRules(ASK_RULES)
  const allow = useTriedRules(ALLOW_RULES)

  return (
    <>
      {/* In lots, by what each is about: the user's own code, what reaches outside a workspace, and what the assistant is given access to. */}
      <SettingsGroup title="Permission defaults" description="What applies to everything your rules below don’t cover." plain>
        <SettingsCard>
          <SettingRow title="Code changes" description="Changes the assistant makes to your gadgets’ code. Auto-accepted only while you’re the only one working on them." soon>
            <SoonSelect label="Code changes" options={[{ id: 'accept', label: 'Auto-accept' }, ASK]} />
          </SettingRow>
          <SettingRow title="Collaborators’ code changes" description="Code changes from other members’ chats in workspaces you share." soon>
            <SoonSelect label="Collaborators’ code changes" options={[ASK, { id: 'accept', label: 'Auto-accept' }]} />
          </SettingRow>
        </SettingsCard>
        <SettingsCard>
          <SettingRow title="Actions" description="Anything that reaches outside a workspace, such as sending an email or creating a ticket. Only action types that allow it are auto-approved." soon>
            <SoonSelect label="Actions" options={[ASK, { id: 'approve', label: 'Auto-approve' }]} />
          </SettingRow>
          <SettingRow title="Who can approve" description="Who can approve actions on your connections in workspaces you share." soon>
            <SoonSelect label="Who can approve" options={[{ id: 'me', label: 'Only me' }, { id: 'builders', label: 'Workspace builders' }]} />
          </SettingRow>
        </SettingsCard>
        <SettingsCard>
          <SettingRow title="Connection requests" description="Connecting a service or an account. No setting or rule can allow this.">
            <span className="text-kumo-subtle">Always ask</span>
          </SettingRow>
          <SettingRow title="Resource access" description="Giving a gadget access to one of your resources. No setting or rule can allow this.">
            <span className="text-kumo-subtle">Always ask</span>
          </SettingRow>
        </SettingsCard>
      </SettingsGroup>
      <ApprovalRules
        title="Always ask"
        description="The strongest setting: the assistant asks before doing anything these rules describe, whatever else is set."
        soon
        placeholder="Describe what to ask about, such as “posting in #general”"
        {...ask}
      />
      <ApprovalRules
        title="Allow without asking"
        description="Overrides the defaults above, but not an Always ask rule."
        soon
        placeholder="Describe what’s allowed, such as “saving an email as a draft”"
        {...allow}
      />
    </>
  )
}
