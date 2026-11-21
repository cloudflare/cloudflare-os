import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Button, Dialog, InputArea, Radio } from '@cloudflare/kumo'
import { Camera, ImageSquare, X } from '@phosphor-icons/react'
import {
  ADMIN_GRANT_LIFETIME_SECONDS,
  ISSUE_REPORT_ERROR_CODES,
  ISSUE_REPORT_PRIORITIES,
  MAX_ISSUE_REPORT_IMAGES,
  MAX_ISSUE_REPORT_TEXT_LENGTH,
  getIssueReportErrorCode,
  type IssueReportPriority,
  type OwnIssueReport,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { useComposerAttachmentDrop } from '../chat/composer/attachments/useComposerAttachmentDrop'
import { canCaptureTab, captureTab } from './captureTab'
import { issueFailure } from './issueFailure'
import { ISSUE_PRIORITY_NAMES } from './issueLabels'
import { REPORT_IMAGE_ACCEPT } from './reportImage'
import { issueReportContext, reportAppVersion, type ReportIssueContext } from './ReportIssueHost'
import { useIssueReportCount } from './useIssueReportCount'
import { useReportImages } from './useReportImages'

const GRANT_HOURS = ADMIN_GRANT_LIFETIME_SECONDS / 3600

// How close to the bound the text gets before its length is shown.
const COUNTER_FROM = MAX_ISSUE_REPORT_TEXT_LENGTH - 200

// Set on the layer that holds the dialog and its backdrop while the tab is captured; one rule
// in styles.css reads it. Kumo renders the backdrop itself, so no class can be put on it.
const CAPTURING_ATTRIBUTE = 'data-report-issue-capturing'

/** What the reporter lets admins read: nothing beyond metadata, or content under a grant. */
type Access = 'metadata' | 'workspace' | 'account'

// What a grant is called where its failure is reported.
const GRANT_NAMES: Record<Exclude<Access, 'metadata'>, string> = {
  workspace: 'Access to this workspace’s content',
  account: 'Access to the content of all your workspaces',
}

type Phase =
  | { step: 'draft'; problem?: string }
  | { step: 'sending' }
  /** The report is filed and stays filed; `failures` names what did not go with it. */
  | { step: 'filed'; failures: string[] }

// Stable, so that it runs when the element mounts and not on every render.
const focusOnMount = (node: HTMLElement | null) => { node?.focus() }

const DIALOG_CLASS =
  'responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(520px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0'

/**
 * Where a user files an issue report for the deployment's admins: what went wrong, a priority,
 * up to MAX_ISSUE_REPORT_IMAGES images, and whether admins may read content to look into it.
 * The report is filed first and stays filed: its images and the grant follow one at a time, and
 * whichever of them fails is named beside the confirmation. Rendered by ReportIssueProvider
 * alone, mounted while it should be open; `onClosed` is called once it has closed.
 */
export const ReportIssueDialog = ({ context, onClosed }: {
  context: ReportIssueContext
  onClosed: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const serverConfig = useServerConfig()
  const { refresh: refreshCount } = useIssueReportCount()
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<IssueReportPriority>('medium')
  const [access, setAccess] = useState<Access>('metadata')
  const [phase, setPhase] = useState<Phase>({ step: 'draft' })
  const [captureProblem, setCaptureProblem] = useState<string | null>(null)
  const images = useReportImages()
  const content = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const captureButton = useRef<HTMLButtonElement>(null)
  // The latest press of Capture, while the browser's prompt for it can still be unanswered. A
  // prompt can stay so for good (one dismissed by a click elsewhere, in a browser that then
  // leaves the request pending), so it holds nothing back: the dialog closes under it and
  // Capture can be pressed again, and either withdraws the press. So does an unmount that is
  // no close, as when the signed-in shell around the dialog is replaced.
  const capturePress = useRef<AbortController | null>(null)
  useEffect(() => () => { capturePress.current?.abort() }, [])
  // True while the dialog is out of sight for a capture.
  const hiddenForCapture = useRef(false)
  // Set while a capture is about to fill the last slot: the Capture button is then disabled,
  // so focus goes to the Remove button of the preview the capture added.
  const focusLastPreview = useRef(false)
  const captures = useRef(0)

  // The server decides who may give a grant; these only keep an option nobody could use out of
  // sight. A collaborator is offered neither: a grant for all of their own workspaces would not
  // cover the one they report from, and the server refuses it with such a report.
  const canGrant = serverConfig?.adminContentGrants === true
  const offersWorkspace = canGrant && context.workspace?.owned === true
  const offersAccount = canGrant && (context.workspace === undefined || context.workspace.owned)

  // Counted as the server counts it: UTF-16 code units of the text once trimmed.
  const trimmed = text.trim()
  const over = trimmed.length > MAX_ISSUE_REPORT_TEXT_LENGTH
  const drafting = phase.step === 'draft'

  const addFiles = (files: File[]) => {
    setCaptureProblem(null)
    void images.add(files.map((file) => ({ blob: file, name: file.name || 'Pasted image' })))
  }

  const drop = useComposerAttachmentDrop({
    attachmentCount: images.images.length,
    maxAttachments: MAX_ISSUE_REPORT_IMAGES,
    onFilesDropped: (files) => { if (drafting) addFiles(Array.from(files)) },
  })

  const pasteImages = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0 || !drafting) return
    event.preventDefault()
    addFiles(files)
  }

  // Takes the dialog and its backdrop out of the capture's picture without unmounting them, so
  // the draft and the previews stay. While out of sight the dialog is inert as well: a key press
  // cannot reach a control nobody can see. That takes focus from the Capture button, so what
  // puts the dialog back gives the button focus again, after the dialog can take it.
  const hideForCapture = () => {
    const popup = content.current?.closest<HTMLElement>('[role="dialog"]') ?? null
    const layer = popup?.closest<HTMLElement>('[data-base-ui-portal]') ?? popup
    if (popup === null || layer === null) return () => {}
    layer.setAttribute(CAPTURING_ATTRIBUTE, '')
    popup.inert = true
    hiddenForCapture.current = true
    return () => {
      hiddenForCapture.current = false
      popup.inert = false
      layer.removeAttribute(CAPTURING_ATTRIBUTE)
      captureButton.current?.focus()
    }
  }

  const capture = async () => {
    if (hiddenForCapture.current || images.full || !drafting) return
    capturePress.current?.abort()
    const press = new AbortController()
    capturePress.current = press
    setCaptureProblem(null)
    try {
      const picture = await captureTab({ hide: hideForCapture, signal: press.signal })
      if (picture === null) return
      focusLastPreview.current = images.images.length === MAX_ISSUE_REPORT_IMAGES - 1
      const added = await images.add([{ blob: picture, name: `Tab capture ${++captures.current}` }])
      if (added === 0) focusLastPreview.current = false
    } catch (err) {
      // A press that was withdrawn says nothing, as it adds nothing.
      if (press.signal.aborted) return
      console.error('Failed to capture the tab for an issue report:', err)
      setCaptureProblem('Couldn’t capture this tab.')
    }
  }

  // Opens a session of its own for the one call, which leaves on the promise of the workspace,
  // and disposes it: the dialog outlives the editor's route, so it borrows no session.
  const giveAccess = async (to: Exclude<Access, 'metadata'>, reportId: string) => {
    if (to === 'account') {
      await authenticatedApi.grantAccountAdminAccess({ reportId })
      return
    }
    if (context.workspace === undefined) return
    const overseer = authenticatedApi.openWorkspace(context.workspace.id)
    try {
      await overseer.grantAdminAccess({ reportId })
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!drafting || trimmed === '' || over || images.adding) return
    // A picture taken from here on would miss the report.
    capturePress.current?.abort()
    setPhase({ step: 'sending' })
    const file = (where: ReportIssueContext) => authenticatedApi.submitIssueReport({
      text: trimmed,
      priority,
      context: issueReportContext(where, reportAppVersion(serverConfig?.backendVersion)),
    })
    let report: OwnIssueReport
    try {
      report = await file(context).catch((err: unknown) => {
        // The chat or the gadget can be gone by now: deleted since the dialog opened, or named
        // by a link the editor was opened with. The draft has no control that takes either
        // out, so the report is filed for the workspace alone instead of being refused again
        // on every try.
        const named = context.chatId !== undefined || context.gadgetId !== undefined
        if (!named || getIssueReportErrorCode(err) !== ISSUE_REPORT_ERROR_CODES.contextNotFound) {
          throw err
        }
        return file({ workspace: context.workspace })
      })
    } catch (err) {
      setPhase({ step: 'draft', problem: issueFailure(err, 'Couldn’t file your report.') })
      return
    }
    // Nothing from here on is tried twice, and nothing stops what comes after it.
    const failures: string[] = []
    for (const image of images.images) {
      try {
        // Streamed, with the length the server is told before it reads a byte.
        await authenticatedApi.addIssueReportImage(report.id, image.blob.stream(), image.blob.size)
      } catch (err) {
        failures.push(`${image.name}: ${issueFailure(err, 'This image could not be uploaded.')}`)
      }
    }
    if (access !== 'metadata') {
      try {
        await giveAccess(access, report.id)
      } catch (err) {
        failures.push(`${GRANT_NAMES[access]}: ${issueFailure(err, 'It could not be given.')}`)
      }
    }
    refreshCount()
    setPhase({ step: 'filed', failures })
  }

  const busy = phase.step === 'sending'
  const problems = captureProblem === null ? images.problems : [...images.problems, captureProblem]

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // A key press while the dialog is out of sight for a capture must not close it.
        if (!next && (busy || hiddenForCapture.current)) return
        if (!next) capturePress.current?.abort()
        setOpen(next)
      }}
      onOpenChangeComplete={(next) => { if (!next) onClosed() }}
    >
      <Dialog className={DIALOG_CLASS} size="lg">
        <div
          ref={content}
          className="flex min-h-0 flex-1 flex-col"
          onPaste={pasteImages}
          onDragEnter={drop.onDragEnter}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          onDrop={drop.onDrop}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] font-medium leading-5 tracking-[-0.3px] text-kumo-default">
                Report issue
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] font-normal leading-4 tracking-[-0.2px] text-kumo-subtle">
                Tell this deployment’s admins what went wrong. They answer in My issues.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="ghost" shape="square" size="sm" disabled={busy}
                  icon={<X size={16} />} aria-label="Close" />
              )}
            />
          </div>

          {phase.step === 'filed' ? (
            <>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6">
                <p ref={focusOnMount} tabIndex={-1} role="status"
                  className="text-sm text-kumo-default focus:outline-none">
                  <span className="font-medium">Report filed.</span>{' '}
                  <Link to="/issues" onClick={() => setOpen(false)}
                    className="text-kumo-brand underline">
                    Follow it in My issues
                  </Link>
                </p>
                {phase.failures.length > 0 && (
                  <div role="alert" className="space-y-1 text-sm text-kumo-danger">
                    <p>Not everything went with it:</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {/* Written once and never reordered: the index is the key. */}
                      {phase.failures.map((failure, index) => <li key={index}>{failure}</li>)}
                    </ul>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 justify-end border-t border-kumo-line px-4 py-3 sm:px-6">
                <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
              </div>
            </>
          ) : (
            <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
                <div className="grid gap-2">
                  <InputArea
                    label="What went wrong?"
                    required
                    autoFocus
                    rows={4}
                    disabled={busy}
                    value={text}
                    onValueChange={setText}
                  />
                  {trimmed.length >= COUNTER_FROM && (
                    <p role="status" className={`text-xs ${over ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
                      {trimmed.length} of {MAX_ISSUE_REPORT_TEXT_LENGTH} characters
                      {over && ': shorten your report to send it'}
                    </p>
                  )}
                </div>

                <Radio.Group legend="Priority" orientation="horizontal" disabled={busy}
                  value={priority} onValueChange={setPriority}>
                  {ISSUE_REPORT_PRIORITIES.map((value) => (
                    <Radio.Item key={value} value={value} label={ISSUE_PRIORITY_NAMES[value]} />
                  ))}
                </Radio.Group>

                <div
                  role="group"
                  aria-labelledby="report-issue-images"
                  className={`space-y-2 rounded-lg ${drop.isActive ? 'outline outline-2 outline-offset-4 outline-kumo-brand' : ''}`}
                >
                  <p id="report-issue-images" className="text-sm font-medium text-kumo-default">Images</p>
                  <p className="text-xs text-kumo-subtle">
                    Up to {MAX_ISSUE_REPORT_IMAGES}: PNG, JPEG or WebP. You can also paste or drop
                    them here.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {canCaptureTab() && (
                      <Button ref={captureButton} type="button" variant="secondary" size="sm"
                        icon={<Camera size={14} />} disabled={busy || images.full}
                        onClick={() => void capture()}>
                        Capture this tab
                      </Button>
                    )}
                    <Button ref={addButton} type="button" variant="secondary" size="sm"
                      icon={<ImageSquare size={14} />} disabled={busy || images.full}
                      onClick={() => fileInput.current?.click()}>
                      Add images
                    </Button>
                    {/* Reached through the button above; out of sight and of the tab order. */}
                    <input
                      ref={fileInput}
                      type="file"
                      aria-label="Images to attach"
                      accept={REPORT_IMAGE_ACCEPT}
                      multiple
                      disabled={busy || images.full}
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? [])
                        event.currentTarget.value = ''
                        if (files.length > 0) addFiles(files)
                      }}
                    />
                  </div>
                  {images.adding && (
                    <p role="status" className="text-xs text-kumo-subtle">Preparing images…</p>
                  )}
                  {images.images.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {images.images.map((image, index) => (
                        <li key={image.id}
                          className="relative h-20 w-28 overflow-hidden rounded-md border border-kumo-line bg-kumo-recessed">
                          <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
                          <Button
                            ref={(node: HTMLButtonElement | null) => {
                              if (node === null || !focusLastPreview.current) return
                              if (index !== MAX_ISSUE_REPORT_IMAGES - 1) return
                              focusLastPreview.current = false
                              node.focus()
                            }}
                            type="button" variant="secondary" shape="square" size="xs"
                            className="absolute right-1 top-1" disabled={busy}
                            icon={<X size={12} />} aria-label={`Remove ${image.name}`}
                            onClick={() => {
                              // The button goes with its preview, and Add images takes focus
                              // only once it is drawn enabled: it is disabled while every slot
                              // is taken.
                              flushSync(() => images.remove(image.id))
                              addButton.current?.focus()
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                  {problems.length > 0 && (
                    <ul role="alert" className="space-y-1 text-sm text-kumo-danger">
                      {/* Two refused images can share a name and a reason: the index is the key. */}
                      {problems.map((problem, index) => <li key={index}>{problem}</li>)}
                    </ul>
                  )}
                </div>

                <div className="space-y-2">
                  <Radio.Group legend="Give admins access to" disabled={busy}
                    value={access} onValueChange={setAccess}>
                    <Radio.Item value="metadata" label="Metadata only" />
                    {offersWorkspace && <Radio.Item value="workspace" label="Content of this workspace" />}
                    {offersAccount && <Radio.Item value="account" label="Content of all my workspaces" />}
                  </Radio.Group>
                  {offersAccount && (
                    <p className="text-xs text-kumo-subtle">
                      For {GRANT_HOURS} hours; you can end it sooner in My issues. Everything an
                      admin reads under a grant is recorded.
                    </p>
                  )}
                </div>
              </div>

              <div className="shrink-0 space-y-2 border-t border-kumo-line px-4 py-3 sm:px-6">
                {phase.step === 'draft' && phase.problem !== undefined && (
                  <p role="alert" className="text-sm text-kumo-danger">{phase.problem}</p>
                )}
                <div className="flex justify-end gap-2">
                  <Dialog.Close
                    render={(props) => (
                      <Button {...props} type="button" variant="secondary" disabled={busy}>Cancel</Button>
                    )}
                  />
                  {/* Held while an image is prepared: the report would be sent without it. */}
                  <Button type="submit" variant="primary" loading={busy}
                    disabled={trimmed === '' || over || images.adding}>
                    Send report
                  </Button>
                </div>
              </div>
            </form>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
