// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import type { GadgetExportFormat } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const mocks = vi.hoisted(() => ({
  saveStreamToFile: vi.fn<(
    createStream: () => Promise<ReadableStream<Uint8Array>>,
    filename: string,
    fileType: {description: string; contentType: string; extension: string},
  ) => Promise<void>>(),
  toast: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children, onOpenChange }: {
      children: ReactNode
      onOpenChange?: (open: boolean) => void
    }) => (
      <div>
        <button type="button" onClick={() => onOpenChange?.(true)}>open export menu</button>
        <button type="button" onClick={() => onOpenChange?.(false)}>close export menu</button>
        {children}
      </div>
    ),
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
        <button type="button" onClick={onClick}>{children}</button>
      ),
    },
  )
  return {
    DropdownMenu,
    Tooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
      <div data-tooltip={content}>{children}</div>
    ),
    useKumoToastManager: () => ({ add: mocks.toast }),
  }
})

vi.mock('@phosphor-icons/react', () => ({
  DownloadSimple: () => <span>download</span>,
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./fileTransfers', () => ({
  makeExportFilename: (title: string, extension: string) => `${title}${extension}`,
  saveStreamToFile: mocks.saveStreamToFile,
}))

import GadgetExportMenu from './GadgetExportMenu'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.saveStreamToFile.mockReset()
  mocks.toast.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function gadget(overrides: Partial<GadgetClient>): RpcStub<GadgetClient> {
  return overrides as RpcStub<GadgetClient>
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find(candidate => candidate.textContent === label)
}

describe('GadgetExportMenu', () => {
  it('loads formats on open and exports the selected one with its metadata', async () => {
    const exportFormat = vi.fn<(
      id: string,
      chatId?: number,
    ) => Promise<ReadableStream<Uint8Array>>>(
      async () => new ReadableStream<Uint8Array>(),
    )
    const formats: GadgetExportFormat[] = [{
      id: 'csv',
      label: 'CSV',
      mode: 'server',
      contentType: 'text/csv',
      fileExtension: '.csv',
    }]
    const client = gadget({
      getExportFormats: vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>(
        async () => formats,
      ),
      export: exportFormat,
    })
    mocks.saveStreamToFile.mockImplementation(async (createStream) => {
      await createStream()
    })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" chatId={7} />)
    })
    expect(client.getExportFormats).not.toHaveBeenCalled()

    await act(async () => { button('open export menu')?.click() })
    await act(async () => { button('CSV')?.click() })

    expect(client.getExportFormats).toHaveBeenCalledWith(7)
    expect(exportFormat).toHaveBeenCalledWith('csv', 7)
    expect(mocks.saveStreamToFile).toHaveBeenCalledWith(
      expect.any(Function),
      'Report.csv',
      { description: 'CSV', contentType: 'text/csv', extension: '.csv' },
    )
  })

  it('disables the export button and updates its tooltip while exporting', async () => {
    let finishExport!: () => void
    const pendingExport = new Promise<void>(resolve => { finishExport = resolve })
    const format: GadgetExportFormat = {
      id: 'csv',
      label: 'CSV',
      mode: 'server',
      contentType: 'text/csv',
      fileExtension: '.csv',
    }
    const client = gadget({
      getExportFormats: vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>(
        async () => [format],
      ),
    })
    mocks.saveStreamToFile.mockReturnValue(pendingExport)

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" />)
    })
    await act(async () => { button('open export menu')?.click() })
    await act(async () => { button('CSV')?.click() })

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Export Gadget"]')
    expect(trigger?.disabled).toBe(true)
    expect(trigger?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Exporting to CSV')

    await act(async () => {
      finishExport()
      await pendingExport
    })

    expect(trigger?.disabled).toBe(false)
    expect(trigger?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Export Gadget')
  })

  it('shows an empty state without hiding or disabling the export button', async () => {
    const client = gadget({
      getExportFormats: vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>(
        async () => [],
      ),
    })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" />)
    })
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Export Gadget"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.disabled).toBe(false)

    await act(async () => { button('open export menu')?.click() })

    expect(container.textContent).toContain('This Gadget does not support exports.')
    expect(container.querySelector('[aria-label="Export Gadget"]')).not.toBeNull()
  })

  it('does not render the control without a selected Gadget', async () => {
    await act(async () => {
      root.render(<GadgetExportMenu gadget={null} gadgetTitle="Gadget" />)
    })

    expect(container.querySelector('[aria-label="Export Gadget"]')).toBeNull()
  })

  it('loads fresh formats on every open and ignores a response after close', async () => {
    let resolveFirst!: (formats: GadgetExportFormat[]) => void
    const first = new Promise<GadgetExportFormat[]>(resolve => { resolveFirst = resolve })
    const second: GadgetExportFormat[] = [{
      id: 'csv:second', label: 'Second sheet', mode: 'server',
      contentType: 'text/csv', fileExtension: '.csv',
    }]
    const getExportFormats = vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(second)
    const client = gadget({ getExportFormats })

    await act(async () => {
      root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" />)
    })
    await act(async () => { button('open export menu')?.click() })

    expect(container.querySelector('[role="status"][aria-label="Loading export formats"]')).not.toBeNull()
    await act(async () => { button('close export menu')?.click() })
    expect(container.querySelector('[role="status"][aria-label="Loading export formats"]')).toBeNull()

    await act(async () => { button('open export menu')?.click() })
    expect(container.textContent).toContain('Second sheet')

    await act(async () => {
      resolveFirst([{
        id: 'csv:first', label: 'First sheet', mode: 'server',
        contentType: 'text/csv', fileExtension: '.csv',
      }])
      await first
    })

    expect(container.textContent).not.toContain('First sheet')
    expect(container.textContent).toContain('Second sheet')
    expect(getExportFormats).toHaveBeenCalledTimes(2)
  })

  it('shows an inline error and retries format discovery', async () => {
    const format: GadgetExportFormat = {
      id: 'html', label: 'HTML', mode: 'browser',
      contentType: 'text/html', fileExtension: '.html',
    }
    const getExportFormats = vi.fn<(chatId?: number) => Promise<GadgetExportFormat[]>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([format])
    const client = gadget({ getExportFormats })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await act(async () => {
        root.render(<GadgetExportMenu gadget={client} gadgetTitle="Report" />)
      })
      await act(async () => { button('open export menu')?.click() })

      expect(container.textContent).toContain('Export formats could not be loaded.')
      expect(button('Try again')).toBeDefined()

      await act(async () => { button('Try again')?.click() })

      expect(button('HTML')).toBeDefined()
      expect(getExportFormats).toHaveBeenCalledTimes(2)
      expect(mocks.toast).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })
})
