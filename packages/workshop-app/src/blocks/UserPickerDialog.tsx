import { Cancel01Icon, Tick02Icon } from '@/components/icons'
import { Avatar, Banner, Button, Dialog } from '@gadgets/ui'
import { InviteField, type InviteSuggestions } from './InviteField'

export type UserPickerDialogProps = {
  /** Who it is for: the app that asked, by its title. */
  appTitle: string
  value: string
  onValueChange: (value: string) => void
  /** Adds whoever was typed or chosen. */
  onPick: (userId: string) => void
  /** Those added, by the name the Workshop gave the app for them. */
  picked: readonly { id: string; name: string }[]
  /** Someone is being added, and no one else can be until they are. */
  pending: boolean
  /** People the deployment can be searched for, when it can be. */
  suggestions?: InviteSuggestions
  /** Why the last person chosen was not added. */
  notice?: string
  /** Who was added last, said aloud. */
  announcement: string
  /** Done was chosen, and it waits for whoever is being added. */
  closing: boolean
  /** Done, or Escape: closes once whoever is being added is in. */
  onClose: () => void
  /** Closes at once, while it waits. */
  onStopWaiting: () => void
}

/**
 * The Workshop's own picker of people, over a gatekeeper's app that asked for it: each person is
 * added as the app takes them, one at a time, and Done closes it once the last is in. The app is
 * told who was chosen and nothing else of them.
 */
export const UserPickerDialog = ({ appTitle, value, onValueChange, onPick, picked, pending, suggestions, notice, announcement, closing, onClose, onStopWaiting }: UserPickerDialogProps) => (
  <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <header className="flex items-start gap-3 p-6 pb-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
        <Dialog.Title className="text-lg font-medium text-kumo-default">Choose people</Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle">{appTitle} is told who you choose, for what you’re doing in it.</Dialog.Description>
      </div>
      <Button variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" disabled={closing} onClick={onClose} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />
    </header>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-1 pb-1">
      <InviteField
        value={value}
        onValueChange={onValueChange}
        onInvite={onPick}
        pending={pending || closing}
        suggestions={suggestions}
        invalid={notice !== undefined}
        describedBy={notice ? 'user-picker-notice' : undefined}
        action={{ label: 'Add', pendingLabel: 'Adding…' }}
      />
      {notice && <div id="user-picker-notice"><Banner title={notice} /></div>}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {picked.length > 0 && (
        <ul aria-label="Added" className="flex flex-col gap-1">
          {picked.map((person) => (
            <li key={person.id} className="flex items-center gap-3 py-1 text-base text-kumo-default">
              <Avatar name={person.name} small />
              <span className="min-w-0 flex-1 truncate">{person.name}</span>
              <Tick02Icon aria-label="Added" weight="bold" className="size-4 text-kumo-success" />
            </li>
          ))}
        </ul>
      )}
      {closing && (
        <div role="status" className="flex flex-col items-start gap-2 text-sm text-kumo-subtle">
          <p>Waiting for {appTitle}. Closing now can’t undo whoever it has taken already.</p>
          <Button onClick={onStopWaiting}>Stop waiting and close</Button>
        </div>
      )}
    </div>
    <footer className="flex justify-end p-6">
      <Button variant="primary" disabled={closing} onClick={onClose}>Done</Button>
    </footer>
  </Dialog>
)
