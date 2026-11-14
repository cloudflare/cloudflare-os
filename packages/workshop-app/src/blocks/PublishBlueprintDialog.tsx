import { useState } from 'react'
import { Input, InputArea } from '@cloudflare/kumo'
import { AppWindowIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { ShimmerText } from '@/components/ShimmerText'
import { BlueprintPicture } from './BlueprintTile'

export type PublishBlueprintDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it starts as: the gadget's title, and what its blueprint said it was for. */
  initialTitle: string
  initialDescription?: string
  /**
   * Publishes it. Resolves to whether it was tried (`false` when the connection is down); it then
   * says it is done, and rejects with why it was not.
   */
  onPublish: (title: string, description: string) => Promise<boolean>
  /**
   * The picture that goes with it, of the gadget as it looks now: being drawn, drawn, or none
   * (`null`), for a gadget with no screen or one that could not be drawn.
   */
  picture?: { status: 'drawing' } | { status: 'ready'; url: string } | null
  /** Once it is published, opens its page. */
  onOpen?: () => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Publishes a gadget's code as a blueprint: its picture, as the gadget looks now, then its name and
 * what it is for, as others will find it. Its connections go with it as what a copy needs, not as
 * the accounts they go through. Once published, its page is a click away.
 */
export const PublishBlueprintDialog = ({ open, onOpenChange, initialTitle, initialDescription = '', onPublish, picture, onOpen }: PublishBlueprintDialogProps) => {
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [pending, setPending] = useState(false)
  const [published, setPublished] = useState(false)
  const [problem, setProblem] = useState<string>()

  const publish = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      if (await onPublish(title.trim(), description.trim())) setPublished(true)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      onClosed={() => {
        setPublished(false)
        setProblem(undefined)
      }}
      title={published ? 'Published' : 'Publish as blueprint'}
      description={published
        ? `“${title.trim()}” is a blueprint now. Anyone here can start their own from it.`
        : 'Anyone here can start their own gadget from it. What it is connected to goes with it as what a copy needs, never your accounts.'}
      footer={published ? (
        <>
          {onOpen && <Button onClick={onOpen}>Open blueprint</Button>}
          <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
        </>
      ) : (
        <>
          <Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || !title.trim()} onClick={() => void publish()}>{pending ? 'Publishing…' : 'Publish'}</Button>
        </>
      )}
    >
      {picture && (
        <figure className="flex flex-col gap-1.5">
          <span className="relative block overflow-hidden rounded-2xl ring-1 ring-kumo-contrast/6">
            <BlueprintPicture picture={picture.status === 'ready' ? picture.url : undefined} icon={<AppWindowIcon />} />
            {picture.status === 'drawing' && (
              <span className="absolute inset-x-0 bottom-0 bg-kumo-base/85 px-3 py-1.5 text-center text-sm backdrop-blur-sm">
                <ShimmerText>Drawing its picture…</ShimmerText>
              </span>
            )}
          </span>
          {!published && <figcaption className="px-1 text-sm text-kumo-subtle">Its picture, as it looks now, goes with it.</figcaption>}
        </figure>
      )}
      {!published && (
        <div className="flex flex-col gap-4">
          <Input label="Name" value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} />
          <InputArea
            label="What it’s for"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Keep your tasks in check"
            rows={3}
            disabled={pending}
          />
        </div>
      )}
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
