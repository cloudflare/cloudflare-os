// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  ISSUE_REPORT_ERROR_CODES,
  MAX_ISSUE_REPORT_TEXT_LENGTH,
  createAdminAccessError,
  createIssueReportError,
  type AdminAccessGrant,
  type AuthenticatedApi,
  type IssueReportImage,
  type Overseer,
  type OwnIssueReport,
  type ServerConfig,
} from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => ({
  authenticatedApi: {} as unknown,
  serverConfig: {} as unknown,
  refreshCount: vi.fn<() => void>(),
  prepare: vi.fn<(image: Blob) => Promise<Blob>>(async (image) => image),
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => mocks.serverConfig,
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, onClick }: { to: string; children: ReactNode; onClick?: () => void }) => (
    <a href={to} onClick={(event) => { event.preventDefault(); onClick?.() }}>{children}</a>
  ),
}))
vi.mock('./useIssueReportCount', () => ({
  useIssueReportCount: () => ({ count: 0, read: 0, refresh: mocks.refreshCount }),
}))
vi.mock('./reportImage', async (original) => ({
  ...(await original<typeof import('./reportImage')>()),
  prepareReportImage: mocks.prepare,
}))

import { ReportIssueDialog } from './ReportIssueDialog'
import type { ReportIssueContext } from './ReportIssueHost'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const REPORT: OwnIssueReport = {
  id: 'report-1',
  filedAt: new Date('2026-10-12T09:30:00Z'),
  reporter: { id: 'profile-rita', name: 'Rita Reporter' },
  text: 'The export button does nothing',
  priority: 'medium',
  context: {},
  status: 'new',
  images: [],
  unseen: false,
}

const GRANT: AdminAccessGrant = {
  id: 'grant-1',
  level: 'content',
  source: 'owner',
  scope: 'workspace',
  grantedBy: { id: 'profile-rita', name: 'Rita Reporter' },
  grantedAt: new Date('2026-10-12T09:30:00Z'),
  expiresAt: new Date('2026-10-15T09:30:00Z'),
}

const OWNED: ReportIssueContext = { workspace: { id: 'w1', owned: true } }
const EDITOR: ReportIssueContext = { workspace: { id: 'w1', owned: true }, chatId: 7, gadgetId: 3 }
const SHARED: ReportIssueContext = { workspace: { id: 'w1', owned: false } }
const HOME: ReportIssueContext = {}

const CONTENT: ServerConfig = { adminContentGrants: true, backendVersion: '1.2.3' } as ServerConfig
const METADATA_ONLY: ServerConfig = { backendVersion: '1.2.3' } as ServerConfig

/**
 * The reporter's API, with the workspace openWorkspace() promises. `calls` records every call
 * in the order it was made, an image by the length it was sent with.
 */
const fakeApi = () => {
  const calls: string[] = []
  const overseer = {
    grantAdminAccess: vi.fn<Overseer['grantAdminAccess']>(async () => {
      calls.push('grantAdminAccess')
      return GRANT
    }),
    [Symbol.dispose]: vi.fn<() => void>(() => { calls.push('dispose') }),
  }
  const api = {
    submitIssueReport: vi.fn<AuthenticatedApi['submitIssueReport']>(async () => {
      calls.push('submit')
      return REPORT
    }),
    addIssueReportImage: vi.fn<AuthenticatedApi['addIssueReportImage']>(async (_id, _image, byteLength) => {
      calls.push(`image:${byteLength}`)
      return { id: `image-${byteLength}`, type: 'image/png', byteLength } as IssueReportImage
    }),
    openWorkspace: vi.fn<(id: string) => typeof overseer>(() => {
      calls.push('openWorkspace')
      return overseer
    }),
    grantAccountAdminAccess: vi.fn<AuthenticatedApi['grantAccountAdminAccess']>(async () => {
      calls.push('grantAccountAdminAccess')
      return { ...GRANT, scope: 'account' }
    }),
  }
  return { api, overseer, calls }
}
type FakeApi = ReturnType<typeof fakeApi>

// jsdom's Blob has no stream(): each image gets one that returns a stream of its own, so a test
// can tell whose stream was sent.
const imageFile = (name: string, bytes: number, type = 'image/png') => {
  const file = new File([new Uint8Array(bytes)], name, { type })
  const stream = new ReadableStream<Uint8Array>()
  Object.defineProperty(file, 'stream', { value: () => stream })
  return { file, stream }
}

let host: HTMLDivElement | undefined
let root: Root | undefined
const onClosed = vi.fn<() => void>()

const renderDialog = async (fake: FakeApi, context: ReportIssueContext, config: ServerConfig = CONTENT) => {
  mocks.authenticatedApi = fake.api
  mocks.serverConfig = config
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => { root!.render(<ReportIssueDialog context={context} onClosed={onClosed} />) })
}

const dialog = () => {
  const element = document.body.querySelector<HTMLElement>('[role="dialog"]')
  if (element === null) throw new Error('no dialog')
  return element
}
const button = (name: string) => {
  const found = [...dialog().querySelectorAll('button')]
    .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
const radios = (legend: string) => {
  const group = [...dialog().querySelectorAll('fieldset')]
    .find((element) => element.textContent?.startsWith(legend))
  if (group === undefined) throw new Error(`no group "${legend}"`)
  return [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
}
const radioName = (radio: HTMLElement) => radio.closest('label')!.textContent!.trim()
const choices = (legend: string) => radios(legend).map(radioName)
const chosen = (legend: string) =>
  radios(legend).filter((radio) => radio.getAttribute('aria-checked') === 'true').map(radioName)
// Through the radio's own input: the visible control clicks it with a PointerEvent, which jsdom
// does not have.
const choose = (legend: string, name: string) => act(async () => {
  radios(legend).find((radio) => radioName(radio) === name)!.closest('label')!.querySelector('input')!.click()
})

const typeText = (value: string) => act(async () => {
  const field = dialog().querySelector('textarea')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const attach = (...files: File[]) => act(async () => {
  const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change', { bubbles: true }))
})

const send = () => act(async () => { button('Send report').click() })

const ACCESS = 'Give admins access to'

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.restoreAllMocks()
  mocks.refreshCount.mockClear()
  mocks.prepare.mockReset().mockImplementation(async (image) => image)
  onClosed.mockClear()
})

describe('what the dialog offers', () => {
  it('starts on "Metadata only", which gives no grant', async () => {
    const fake = fakeApi()
    await renderDialog(fake, OWNED)
    expect(chosen(ACCESS)).toEqual(['Metadata only'])
    expect(chosen('Priority')).toEqual(['Medium'])

    await typeText('The export button does nothing')
    await send()

    expect(fake.calls).toEqual(['submit'])
    expect(fake.api.openWorkspace).not.toHaveBeenCalled()
    expect(fake.api.grantAccountAdminAccess).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('Report filed.')
  })

  it('offers both content options to the owner of the workspace, and says reads are recorded', async () => {
    await renderDialog(fakeApi(), OWNED)
    expect(choices(ACCESS))
      .toEqual(['Metadata only', 'Content of this workspace', 'Content of all my workspaces'])
    expect(dialog().textContent).toContain(
      'For 72 hours; you can end it sooner in My issues. Everything an admin reads under a grant is recorded.',
    )
  })

  it('offers only "all my workspaces" from the home page', async () => {
    await renderDialog(fakeApi(), HOME)
    expect(choices(ACCESS)).toEqual(['Metadata only', 'Content of all my workspaces'])
  })

  it('offers a collaborator no content option', async () => {
    await renderDialog(fakeApi(), SHARED)
    expect(choices(ACCESS)).toEqual(['Metadata only'])
    expect(dialog().textContent).not.toContain('72 hours')
  })

  it.each([['an owner', OWNED], ['the home page', HOME]])(
    'offers %s no content option where the deployment does not allow content', async (_who, context) => {
      await renderDialog(fakeApi(), context, METADATA_ONLY)
      expect(choices(ACCESS)).toEqual(['Metadata only'])
    },
  )

  it('carries no session in its context', () => {
    expectTypeOf<keyof ReportIssueContext>().toEqualTypeOf<'workspace' | 'chatId' | 'gadgetId'>()
    expectTypeOf<NonNullable<ReportIssueContext['workspace']>>()
      .toEqualTypeOf<{ id: string; owned: boolean }>()
  })
})

describe('what a report says of where its reporter was', () => {
  it.each([
    ['the editor', EDITOR, { workspaceId: 'w1', chatId: 7, gadgetId: 3, appVersion: '1.2.3' }],
    ['a workspace’s menu', OWNED, { workspaceId: 'w1', appVersion: '1.2.3' }],
    ['the home page', HOME, { appVersion: '1.2.3' }],
  ])('from %s', async (_where, context, expected) => {
    const fake = fakeApi()
    await renderDialog(fake, context)
    await typeText('  The export button does nothing  ')
    await choose('Priority', 'High')
    await send()

    expect(fake.api.submitIssueReport).toHaveBeenCalledExactlyOnceWith({
      text: 'The export button does nothing',
      priority: 'high',
      context: expected,
    })
    const sent = fake.api.submitIssueReport.mock.calls[0][0].context!
    expect(Object.keys(sent).toSorted()).toEqual(Object.keys(expected).toSorted())
  })
})

describe('what a report says of the app its reporter ran', () => {
  it('names the frontend build the page runs before the backend it is connected to', async () => {
    // The page's entry script, as a build names it.
    const entry = document.head.appendChild(document.createElement('script'))
    entry.type = 'module'
    entry.setAttribute('src', '/assets/index-OLDBUILD.js')
    try {
      const fake = fakeApi()
      // A newer backend than the page: the connection moved to it and the page was not reloaded.
      await renderDialog(fake, HOME, { backendVersion: 'backend-new' } as ServerConfig)
      await typeText('The export button does nothing')
      await send()

      expect(fake.api.submitIssueReport.mock.calls[0][0].context)
        .toEqual({ appVersion: '/assets/index-OLDBUILD.js @ backend-new' })
    } finally {
      entry.remove()
    }
  })
})

describe('a report from an editor whose chat or gadget is gone', () => {
  const gone = () => createIssueReportError(ISSUE_REPORT_ERROR_CODES.contextNotFound)

  it('is filed for the workspace alone, with its images and its grant', async () => {
    const fake = fakeApi()
    fake.api.submitIssueReport.mockRejectedValueOnce(gone())
    await renderDialog(fake, EDITOR)
    await typeText('The export button does nothing')
    await attach(imageFile('one.png', 1).file)
    await send()

    expect(fake.api.submitIssueReport.mock.calls.map(([input]) => input.context)).toEqual([
      { workspaceId: 'w1', chatId: 7, gadgetId: 3, appVersion: '1.2.3' },
      { workspaceId: 'w1', appVersion: '1.2.3' },
    ])
    expect(fake.api.addIssueReportImage).toHaveBeenCalledOnce()
    expect(dialog().querySelector('textarea')).toBeNull()
  })

  it('stays a draft when the workspace is what cannot be opened', async () => {
    const fake = fakeApi()
    fake.api.submitIssueReport.mockRejectedValue(gone())
    await renderDialog(fake, EDITOR)
    await typeText('The export button does nothing')
    await send()

    expect(fake.api.submitIssueReport).toHaveBeenCalledTimes(2)
    expect(dialog().querySelector('[role="alert"]')?.textContent)
      .toBe('This report names a workspace, chat or gadget you cannot open.')
    expect(dialog().querySelector('textarea')!.value).toBe('The export button does nothing')
  })

  it('is not sent again when it named neither', async () => {
    const fake = fakeApi()
    fake.api.submitIssueReport.mockRejectedValue(gone())
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await send()

    expect(fake.api.submitIssueReport).toHaveBeenCalledOnce()
  })
})

describe('a capture whose prompt is still unanswered', () => {
  it('is withdrawn when the dialog is unmounted without closing', async () => {
    const stop = vi.fn<() => void>()
    const stream = { getTracks: () => [{ stop, addEventListener: () => {} }] }
    let answerPrompt!: (stream: unknown) => void
    const getDisplayMedia = vi.fn<() => Promise<unknown>>(
      () => new Promise((resolve) => { answerPrompt = resolve }))
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    try {
      await renderDialog(fakeApi(), HOME)
      await act(async () => { button('Capture this tab').click() })
      expect(getDisplayMedia).toHaveBeenCalledOnce()

      // The shell around the dialog is replaced: no close, so nothing else withdraws the press.
      await act(async () => root!.unmount())
      root = undefined
      await act(async () => { answerPrompt(stream) })

      expect(stop).toHaveBeenCalledOnce()
      expect(play).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })
})

describe('sending', () => {
  it('files the report, then sends each image, then gives the grant with the report’s id', async () => {
    const fake = fakeApi()
    const one = imageFile('one.png', 1)
    const two = imageFile('two.png', 2)
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await attach(one.file, two.file)
    await choose(ACCESS, 'Content of this workspace')
    await send()

    expect(fake.calls).toEqual(['submit', 'image:1', 'image:2', 'openWorkspace', 'grantAdminAccess', 'dispose'])
    expect(fake.api.addIssueReportImage.mock.calls).toEqual([
      ['report-1', one.stream, 1],
      ['report-1', two.stream, 2],
    ])
    expect(fake.overseer.grantAdminAccess).toHaveBeenCalledExactlyOnceWith({ reportId: 'report-1' })
    expect(mocks.refreshCount).toHaveBeenCalledOnce()
  })

  it('sends a re-encoded image as the re-encoding, with its length', async () => {
    const fake = fakeApi()
    const large = imageFile('large.png', 64)
    const encoded = imageFile('encoded.webp', 9, 'image/webp')
    mocks.prepare.mockResolvedValueOnce(encoded.file)
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await attach(large.file)
    await send()

    expect(fake.api.addIssueReportImage.mock.calls).toEqual([['report-1', encoded.stream, 9]])
  })

  it('holds Send while an image is still being prepared, so that the report goes with it', async () => {
    const fake = fakeApi()
    const encoded = imageFile('encoded.webp', 9, 'image/webp')
    let finish!: (image: Blob) => void
    mocks.prepare.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    await renderDialog(fake, HOME)
    await typeText('The export button does nothing')
    await attach(imageFile('large.png', 64).file)

    expect(button('Send report').disabled).toBe(true)
    expect(dialog().textContent).toContain('Preparing images…')
    // However the form is asked to submit, nothing is filed without the image.
    await act(async () => { dialog().querySelector('form')!.requestSubmit() })
    expect(fake.calls).toEqual([])

    await act(async () => { finish(encoded.file) })
    expect(dialog().textContent).not.toContain('Preparing images…')
    expect(button('Send report').disabled).toBe(false)
    await send()
    expect(fake.calls).toEqual(['submit', 'image:9'])
  })

  it.each([
    ['a refusal of the image', createIssueReportError(ISSUE_REPORT_ERROR_CODES.imageNotRecognised),
      'Only PNG, JPEG and WebP images can be attached to an issue report.'],
    ['too many uploads at once', createIssueReportError(ISSUE_REPORT_ERROR_CODES.tooManyUploads),
      'You are uploading too many images to issue reports at once. Try again in a few minutes.'],
    ['an upload the server cut off', new Error('The image upload took too long. Try again.'),
      'The image upload took too long. Try again.'],
  ])('lets the rest go after %s', async (_what, failure, message) => {
    const fake = fakeApi()
    fake.api.addIssueReportImage.mockImplementation(async (_id, _image, byteLength) => {
      fake.calls.push(`image:${byteLength}`)
      if (byteLength === 2) throw failure
      return { id: `image-${byteLength}`, type: 'image/png', byteLength } as IssueReportImage
    })
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await attach(imageFile('one.png', 1).file, imageFile('two.png', 2).file, imageFile('three.png', 3).file)
    await choose(ACCESS, 'Content of this workspace')
    await send()

    // Each call once: the image that failed is not tried again, and neither is anything else.
    expect(fake.calls)
      .toEqual(['submit', 'image:1', 'image:2', 'image:3', 'openWorkspace', 'grantAdminAccess', 'dispose'])
    expect(dialog().textContent).toContain('Report filed.')
    const failures = [...dialog().querySelectorAll('[role="alert"] li')].map((item) => item.textContent)
    expect(failures).toEqual([`two.png: ${message}`])
    expect(dialog().querySelector('a')?.getAttribute('href')).toBe('/issues')
  })

  it('stays a draft, and files nothing twice, when the report itself is refused', async () => {
    const fake = fakeApi()
    fake.api.submitIssueReport
      .mockRejectedValueOnce(createIssueReportError(ISSUE_REPORT_ERROR_CODES.tooManyReports))
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await attach(imageFile('one.png', 1).file)
    await send()

    expect(dialog().querySelector('[role="alert"]')?.textContent)
      .toBe('You have filed too many issue reports today. Try again tomorrow.')
    expect(fake.api.addIssueReportImage).not.toHaveBeenCalled()
    expect(dialog().querySelector('textarea')!.value).toBe('The export button does nothing')
    expect(mocks.refreshCount).not.toHaveBeenCalled()
  })
})

// Images pasted from the clipboard are all called "image.png".
const sameName = () => [1, 2, 3].map((bytes) => imageFile('image.png', bytes).file)
const lines = () => [...dialog().querySelectorAll('[role="alert"] li')].map((item) => item.textContent)

describe('images that share a name', () => {
  it('are numbered, so that each Remove button and each failed upload names one image', async () => {
    const fake = fakeApi()
    const refusal = createIssueReportError(ISSUE_REPORT_ERROR_CODES.imageQuotaReached)
    fake.api.addIssueReportImage.mockRejectedValue(refusal)
    await renderDialog(fake, HOME)
    await typeText('The export button does nothing')
    await attach(...sameName())

    expect([...dialog().querySelectorAll('li button')].map((remove) => remove.getAttribute('aria-label')))
      .toEqual(['Remove image.png', 'Remove image.png (2)', 'Remove image.png (3)'])

    await send()
    expect(dialog().textContent).toContain('Report filed.')
    expect(lines()).toEqual([
      `image.png: ${refusal.message}`,
      `image.png (2): ${refusal.message}`,
      `image.png (3): ${refusal.message}`,
    ])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('are each listed when none of them can be attached', async () => {
    mocks.prepare.mockRejectedValue(new Error('Only PNG, JPEG and WebP images can be attached.'))
    await renderDialog(fakeApi(), HOME)
    await attach(...sameName())

    const refused = 'image.png: Only PNG, JPEG and WebP images can be attached.'
    expect(lines()).toEqual([refused, refused, refused])
    // React reports two list items under one key through console.error.
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('a grant that fails after the report is filed', () => {
  it('names the workspace’s grant as what failed, and disposes the session it opened', async () => {
    const fake = fakeApi()
    fake.overseer.grantAdminAccess.mockRejectedValue(createAdminAccessError('ADMIN_WORKSPACE_CONTENT_OFF'))
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await choose(ACCESS, 'Content of this workspace')
    await send()

    expect(fake.api.submitIssueReport).toHaveBeenCalledOnce()
    expect(fake.overseer.grantAdminAccess).toHaveBeenCalledOnce()
    expect(fake.overseer[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(dialog().textContent).toContain('Report filed.')
    expect(dialog().querySelector('a')?.getAttribute('href')).toBe('/issues')
    expect([...dialog().querySelectorAll('[role="alert"] li')].map((item) => item.textContent)).toEqual([
      'Access to this workspace’s content: Admin access to workspace content is turned off on this deployment.',
    ])
    // The form is gone, so nothing can be sent again.
    expect(dialog().querySelector('form')).toBeNull()
  })

  it('names the account-wide grant as what failed', async () => {
    const fake = fakeApi()
    fake.api.grantAccountAdminAccess.mockRejectedValue(createAdminAccessError('ADMIN_WORKSPACE_CONTENT_OFF'))
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await choose(ACCESS, 'Content of all my workspaces')
    await send()

    expect(fake.api.submitIssueReport).toHaveBeenCalledOnce()
    expect(fake.api.grantAccountAdminAccess).toHaveBeenCalledExactlyOnceWith({ reportId: 'report-1' })
    expect(fake.api.openWorkspace).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('Report filed.')
    expect([...dialog().querySelectorAll('[role="alert"] li')].map((item) => item.textContent)).toEqual([
      'Access to the content of all your workspaces: Admin access to workspace content is turned off on this deployment.',
    ])
    expect(dialog().querySelector('form')).toBeNull()
  })
})

describe('the session the dialog opens for a workspace’s grant', () => {
  it.each([['a workspace’s menu', OWNED], ['the editor', EDITOR]])(
    'is its own, opened from %s once the report is filed, and disposed', async (_where, context) => {
      const fake = fakeApi()
      let file!: (report: OwnIssueReport) => void
      fake.api.submitIssueReport.mockImplementation(() => new Promise((resolve) => { file = resolve }))
      await renderDialog(fake, context)
      await typeText('The export button does nothing')
      await choose(ACCESS, 'Content of this workspace')
      await send()
      expect(fake.api.openWorkspace).not.toHaveBeenCalled()

      await act(async () => { file(REPORT) })
      expect(fake.api.openWorkspace).toHaveBeenCalledExactlyOnceWith('w1')
      expect(fake.overseer.grantAdminAccess).toHaveBeenCalledExactlyOnceWith({ reportId: 'report-1' })
      expect(fake.overseer[Symbol.dispose]).toHaveBeenCalledOnce()
      expect(fake.calls).toEqual(['openWorkspace', 'grantAdminAccess', 'dispose'])
    },
  )

  it('is not opened for the account-wide grant', async () => {
    const fake = fakeApi()
    await renderDialog(fake, OWNED)
    await typeText('The export button does nothing')
    await choose(ACCESS, 'Content of all my workspaces')
    await send()

    expect(fake.calls).toEqual(['submit', 'grantAccountAdminAccess'])
    expect(fake.api.openWorkspace).not.toHaveBeenCalled()
  })
})

describe('the text bound', () => {
  it('counts the trimmed text in UTF-16 code units', async () => {
    const fake = fakeApi()
    await renderDialog(fake, HOME)
    expect(button('Send report').disabled).toBe(true)

    // An emoji is two code units: 1,999 letters and one emoji are one over.
    await typeText(`${'a'.repeat(MAX_ISSUE_REPORT_TEXT_LENGTH - 1)}😀`)
    expect(dialog().querySelector('[role="status"]')?.textContent)
      .toBe('2001 of 2000 characters: shorten your report to send it')
    expect(button('Send report').disabled).toBe(true)

    // At the bound once trimmed: the spaces around it do not count.
    const atBound = `${'a'.repeat(MAX_ISSUE_REPORT_TEXT_LENGTH - 2)}😀`
    await typeText(`  ${atBound}   `)
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe('2000 of 2000 characters')
    expect(button('Send report').disabled).toBe(false)

    await send()
    expect(fake.api.submitIssueReport.mock.calls[0][0].text).toBe(atBound)
  })

  it('takes no blank report', async () => {
    const fake = fakeApi()
    await renderDialog(fake, HOME)
    await typeText('   \n  ')
    expect(button('Send report').disabled).toBe(true)
  })
})

describe('closing', () => {
  it('tells its host once it has closed', async () => {
    await renderDialog(fakeApi(), HOME)
    await act(async () => { button('Close').click() })
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledOnce())
  })
})
