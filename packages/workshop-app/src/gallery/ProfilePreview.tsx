import { useState } from 'react'
import { KeyIcon, SignOutIcon } from '@phosphor-icons/react'
import { ChangePasswordDialog } from '@/blocks/ChangePasswordDialog'
import { MenuChooser } from '@/blocks/MenuChooser'
import { ProfilePicture } from '@/blocks/ProfilePicture'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { PREVIEW_TIP_JAR } from './previewPictures'
import { useReport } from './previewState'
import { Section } from './Section'

const MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet' },
  { id: 'opus', name: 'Claude Opus', description: 'For the hardest work' },
  { id: 'auto', name: 'Auto', description: 'Best model for each request' },
]

/**
 * The profile page's blocks: the picture, with one and with initials, changed from its camera;
 * the default model's chooser; a usage meter in a settings row; and the dialog that changes the
 * password, which can be got wrong.
 */
export const ProfilePreview = () => {
  const { report, say, later } = useReport()
  const [picture, setPicture] = useState<string | undefined>(PREVIEW_TIP_JAR)
  const [model, setModel] = useState('sonnet')
  const [changing, setChanging] = useState<'works' | 'fails'>()

  return (
    <>
      <Section title="ProfilePicture (with a picture, and with initials; its camera chooses another or takes it away)">
        <div className="flex items-center gap-10 py-2">
          <ProfilePicture name="Ada Lovelace" picture={picture} onChoose={(file) => { setPicture(URL.createObjectURL(file)); say(`chose ${file.name}`) }} onRemove={picture ? () => { setPicture(undefined); say('took the picture away') } : undefined} />
          <ProfilePicture name="Grace Hopper" onChoose={(file) => say(`chose ${file.name}`)} />
          <ProfilePicture name="Ada Lovelace" picture={picture} pending onChoose={() => {}} />
        </div>
        <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
      </Section>
      <Section title="SettingsRow + MenuChooser (the profile: default model, AI spend and today’s allowance)">
        <div className="w-full max-w-3xl">
          <SettingsGroup label="Profile">
            <SettingsRow
              title="Default model"
              description="What a new chat starts with. A chat can choose another from its + menu."
              control={<MenuChooser label="Default model" choices={MODELS} value={model} onChoose={(id) => { if (id) { setModel(id); say(`made ${id} the default`) } }} />}
            />
            <SettingsRow title="AI spend" description="Across 3 workspaces, most in Acme launch ($4.12)." control={<span className="text-lg font-medium text-kumo-default tabular-nums">$6.80</span>} />
            <SettingsRow
              title="Free allowance"
              description={<>32 of 50 free today. Starts again at 5:00 PM.<br />Acme pays for more, with $12.40 left.</>}
              control={<span role="meter" aria-label="Free allowance used today" aria-valuemin={0} aria-valuemax={50} aria-valuenow={32} className="block h-1.5 w-28 overflow-hidden rounded-full bg-kumo-contrast/8"><span className="block h-full w-[64%] rounded-full bg-kumo-contrast" /></span>}
            />
            <SettingsRow title="Password" description="Change the password you sign in with." control={<Button icon={KeyIcon} onClick={() => setChanging('works')}>Change</Button>} />
            <SettingsRow title="Sign out" description="Forget your sign-in on this browser. Your workspaces stay as they are." control={<Button icon={SignOutIcon} onClick={() => say('signed out')}>Sign out</Button>} />
          </SettingsGroup>
        </div>
      </Section>
      <Section title="ChangePasswordDialog (too short, not the same twice, then changed; one whose current password is wrong stays open under why)">
        <Button onClick={() => setChanging('works')}>Change password</Button>
        <Button onClick={() => setChanging('fails')}>Change password, wrong</Button>
      </Section>
      <ChangePasswordDialog
        open={changing !== undefined}
        onOpenChange={(open) => { if (!open) setChanging(undefined) }}
        onChange={async () => {
          await later()
          if (changing === 'fails') throw new Error('That isn’t your current password.')
          say('changed the password')
          return true
        }}
      />
    </>
  )
}
