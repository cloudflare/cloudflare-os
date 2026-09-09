// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { Activity, StrictMode, act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RpcStub, RpcTarget } from 'capnweb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Overseer, SlashCommandChoice, ChatAttachmentHandle, GatekeeperClient } from '@gadgets/workshop-shared/api';
import type { ResourceDescription } from '@gadgets/workshop-shared/gatekeeper';
import { ChatInput } from './ChatInput';
import { HomePageContent } from './routes/index';
import { readComposerDraft } from './composerDraft';
import { HubProvider } from './HubContext';

const mocks = vi.hoisted(() => ({
  auth: {} as ReturnType<typeof import('./AuthContext').useAuthenticatedApi>,
  navigate: vi.fn<(options: unknown) => void>(),
  toast: vi.fn<(toast: unknown) => void>(),
  attachCreated: undefined as ComponentProps<typeof import('./GatekeeperModal').default>['onCreated'] | undefined,
}));
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => mocks.auth }));
vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<typeof import('@tanstack/react-router')>(), useNavigate: () => mocks.navigate,
}));
vi.mock('@cloudflare/kumo', () => {
  const childrenOnly = ({ children }: { children?: ReactNode }) => children;
  return {
    Tooltip: childrenOnly,
    useKumoToastManager: () => ({ add: mocks.toast }),
    Button: ({ variant: _variant, shape: _shape, ...props }: ComponentProps<'button'> & { variant?: string; shape?: string }) => <button {...props} />,
    DropdownMenu: Object.assign(childrenOnly, {
      Trigger: ({ render }: { render: ReactNode }) => render,
      Content: childrenOnly,
      Item: (props: ComponentProps<'button'>) => <button {...props} />,
    }),
  };
});
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }));
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<() => void>() }));
vi.mock('./CapsuleOverlay', () => ({
  default: ({ onSelectAccount }: { onSelectAccount: (id: number, vendor: string) => void }) =>
    <button onClick={() => onSelectAccount(1, 'test')}>Connect resource</button>,
  CAPSULE_OVERLAY_GAP: 8,
}));
vi.mock('./GatekeeperModal', () => ({ default: ({ onCreated }: ComponentProps<typeof import('./GatekeeperModal').default>) => {
  mocks.attachCreated = onCreated;
  return null;
} }));
vi.mock('./components/format/ComposerFormatMenuItems', () => ({ default: () => null }));
vi.mock('./components/MeshBackground', () => ({ default: () => null }));
vi.mock('./components/AppShell/HomeTaskSuggestions', () => ({ default: () => null }));
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const command: SlashCommandChoice = {
  selection: { gatekeeperId: 1, commandId: 'brief' },
  name: 'brief', description: 'Write a brief', providerLabel: 'Test',
};

const resourceUrl = 'https://example.com/resource';
const resourceDescription: ResourceDescription = {
  url: resourceUrl, title: 'Resource title', snippet: '', suggestedBindingName: 'RESOURCE', tsType: 'Resource',
};
class Resource extends RpcTarget {
  description = deferred<ResourceDescription>();
  disposed = vi.fn<() => void>();
  describes = vi.fn<() => void>();
  getId() { return 99; }
  describe() { this.describes(); return this.description.promise; }
  getCreationSpec() { return { type: 'gatekeeper', vendorId: 'test' }; }
  [Symbol.dispose]() { this.disposed(); }
}

class Workspace extends RpcTarget {
  catalog = deferred<SlashCommandChoice[]>();
  upload = deferred<ChatAttachmentHandle>();
  deleted: string[] = [];
  chats = vi.fn<Overseer['newChat']>(async () => 7);
  disposed = vi.fn<() => void>();
  uploads = vi.fn<() => void>();
  metadataDelay: Promise<void> = Promise.resolve();
  resource = deferred<Resource>();
  constructor(readonly id: string) { super(); }
  listSlashCommands() { return this.catalog.promise; }
  async getMetadata() { await this.metadataDelay; return { id: this.id }; }
  newChat(...args: Parameters<Overseer['newChat']>) { return this.chats(...args); }
  uploadChatAttachment() { this.uploads(); return this.upload.promise; }
  deleteChatAttachment(id: string) { this.deleted.push(id); }
  newGatekeeper() { return this.resource.promise; }
  [Symbol.dispose]() { this.disposed(); }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Home recovery with the real composer, slash resolver, and RPC ownership', () => {
  let root: Root;
  let container: HTMLDivElement;
  let workspaces: Workspace[];
  let newGadget: ReturnType<typeof vi.fn<() => RpcStub<Overseer>>>;
  let finance: boolean;
  let existingComposer: ComponentProps<typeof ChatInput> | undefined;
  const draftKey = 'gadgets:composer-draft:v1:user-a:home:ops';

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => { throw new Error('Unexpected network request'); }));
    workspaces = [];
    finance = false;
    existingComposer = undefined;
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => Object.assign(createRange(), {
      getBoundingClientRect: () => new DOMRect(),
    }));
    newGadget = vi.fn<() => RpcStub<Overseer>>(() => {
      const workspace = new Workspace(`workspace-${workspaces.length}`);
      workspaces.push(workspace);
      return new RpcStub(workspace) as unknown as RpcStub<Overseer>;
    });
    mocks.auth = {
      authenticatedApi: { newGadget, newGadgetFromBlueprint: newGadget, listModels: async () => [] } as unknown as typeof mocks.auth.authenticatedApi,
      currentUser: { id: 'user-a', name: 'User A', type: 'user' },
      isAdmin: false, logout: vi.fn<() => void>(),
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  async function render(mode: 'visible' | 'hidden' | 'exit' = 'visible') {
    await act(async () => root.render(<StrictMode>{mode === 'exit'
      ? <div>Another route</div>
      : <Activity mode={mode}>{finance
        ? <HubProvider enabledHubs={['ops']} financeStatus={{ authorized: true, canCreate: true }}><HomePageContent /></HubProvider>
        : existingComposer ? <ChatInput {...existingComposer} /> : <HomePageContent />}</Activity>}</StrictMode>));
  }
  async function edit(text: string) {
    await act(async () => {
      const input = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function send() {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
  }
  async function interrupt(kind: 'hidden' | 'exit' | 'api' | 'reveal') {
    if (kind === 'api') {
      mocks.auth = { ...mocks.auth, authenticatedApi: {
        newGadget, newGadgetFromBlueprint: newGadget, listModels: async () => [],
      } as unknown as typeof mocks.auth.authenticatedApi };
      await render();
    } else if (kind === 'reveal') {
      await render('hidden');
      await render();
    } else await render(kind);
  }
  async function attach(bytes?: Promise<ArrayBuffer>) {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes ?? new TextEncoder().encode('hello').buffer });
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function startResource() {
    await edit(resourceUrl);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const connect = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Connect resource');
    expect(connect).toBeDefined();
    await act(async () => connect!.click());
  }

  it.each(['reveal', 'api'] as const)('downgrades completed Home capsules to URLs on %s and sends no old IDs', async (kind) => {
    await render();
    await startResource();
    const old = workspaces[0];
    const resource = new Resource();
    resource.description.resolve(resourceDescription);
    await act(async () => old.resource.resolve(resource));
    expect(container.querySelector('textarea')!.value).toContain('Resource title');
    await interrupt(kind);
    expect(container.querySelector('textarea')!.value).toContain(resourceUrl);
    expect(readComposerDraft(draftKey)?.text).toContain(resourceUrl);
    await send();
    const next = workspaces.at(-1)!;
    expect(next).not.toBe(old);
    expect(next.chats).toHaveBeenCalledOnce();
    expect(next.chats.mock.calls[0][0]).toContain(resourceUrl);
    expect(next.chats.mock.calls[0][2]).toBeUndefined();
    expect(resource.disposed).toHaveBeenCalledOnce();
  });

  it.each([
    ['reveal', 'create'], ['api', 'create'], ['reveal', 'describe'], ['api', 'describe'],
  ] as const)('ignores pending capsule %s / %s results and releases the capability', async (kind, stage) => {
    await render();
    await startResource();
    const old = workspaces[0];
    const resource = new Resource();
    if (stage === 'describe') await act(async () => old.resource.resolve(resource));
    await interrupt(kind);
    await edit('New draft');
    await act(async () => {
      old.resource.resolve(resource);
      resource.description.resolve(resourceDescription);
    });
    expect(container.querySelector('textarea')!.value).toBe('New draft');
    expect(resource.disposed).toHaveBeenCalledOnce();
    expect(resource.describes).toHaveBeenCalledTimes(stage === 'create' ? 0 : 1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each(['reveal', 'api'] as const)('ignores both pending and not-yet-invoked obsolete modal callbacks on %s', async (kind) => {
    await render();
    const callback = mocks.attachCreated!;
    const resource = new Resource();
    let pending!: Promise<void> | void;
    await act(async () => { pending = callback(new RpcStub(resource) as unknown as RpcStub<GatekeeperClient<any>>); });
    await interrupt(kind);
    await edit('Keep new text');
    await act(async () => { resource.description.resolve(resourceDescription); await pending; });
    expect(container.querySelector('textarea')!.value).toBe('Keep new text');
    expect(resource.disposed).toHaveBeenCalledOnce();
    const late = new Resource();
    late.description.resolve(resourceDescription);
    await act(async () => { await callback(new RpcStub(late) as unknown as RpcStub<GatekeeperClient<any>>); });
    expect(late.describes).not.toHaveBeenCalled();
    expect(late.disposed).toHaveBeenCalledOnce();
    expect(container.querySelector('textarea')!.value).toBe('Keep new text');
  });

  it('preserves completed capsules in an existing workspace through hide/reveal and API replacement', async () => {
    const workspace = new Workspace('existing');
    const stub = new RpcStub(workspace) as unknown as RpcStub<Overseer>;
    const onSend = vi.fn<ComponentProps<typeof ChatInput>['onSend']>();
    existingComposer = {
      getOverseer: () => stub, createCapsuleGatekeeper: () => stub.newGatekeeper(1, resourceUrl),
      onSend, models: [], selectedModel: null, onModelChange: () => {}, isAgentActive: false,
    };
    await render();
    await startResource();
    const resource = new Resource();
    resource.description.resolve(resourceDescription);
    await act(async () => workspace.resource.resolve(resource));
    await interrupt('reveal');
    await interrupt('api');
    expect(container.querySelector('textarea')!.value).toContain('Resource title');
    await send();
    expect(onSend.mock.calls[0][2]?.[0].gatekeeperId).toBe(99);
    await render('exit');
    stub[Symbol.dispose]();
  });

  it.each(['hidden', 'exit', 'api', 'reveal'] as const)('abandons slash preparation across %s, without invoking Home creation or clearing the draft', async (kind) => {
    await render();
    await edit('/brief');
    await send();
    const old = workspaces[0];
    expect(old.chats).not.toHaveBeenCalled();
    await interrupt(kind);
    const creations = newGadget.mock.calls.length;
    await act(async () => old.catalog.resolve([command]));
    expect(newGadget).toHaveBeenCalledTimes(creations);
    expect(workspaces.every(workspace => workspace.chats.mock.calls.length === 0)).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(readComposerDraft(draftKey)?.text).toBe('/brief');
  });

  it('does not revive old slash preparation after hide/reveal or unlock a newer send', async () => {
    await render();
    await edit('/brief');
    await send();
    const old = workspaces[0];
    await render('hidden');
    await render();
    await edit('New draft');
    const pending = deferred<number>();
    // Focusing the real composer creates the new provisional workspace.
    await act(async () => container.querySelector('textarea')!.focus());
    const next = workspaces.at(-1)!;
    next.chats.mockReturnValue(pending.promise);
    await send();
    await act(async () => old.catalog.resolve([command]));
    expect(old.chats).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')!.value).toBe('New draft');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
    await act(async () => pending.resolve(12));
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });

  it.each(['hidden', 'exit', 'api'] as const)('deletes a staged attachment through its actual owner on %s, never through a new workspace', async (kind) => {
    await render();
    await attach();
    const owner = workspaces[0];
    await act(async () => owner.upload.resolve({ id: 'attachment-42' }));
    expect(owner.uploads).toHaveBeenCalledOnce();
    await interrupt(kind);
    expect(newGadget).toHaveBeenCalledTimes(1);
    expect(owner.deleted).toEqual(['attachment-42']);
    expect(owner.disposed).toHaveBeenCalledOnce();
  });

  it('cleans a late upload through its old owner after hide/reveal, without touching the new attachment', async () => {
    await render();
    await attach();
    const old = workspaces[0];
    await render('hidden');
    await render();
    await attach();
    const next = workspaces.at(-1)!;
    expect(next).not.toBe(old);
    await act(async () => next.upload.resolve({ id: 'attachment-42' }));
    await act(async () => old.upload.resolve({ id: 'attachment-42' }));
    expect(old.deleted).toEqual(['attachment-42']);
    expect(old.disposed).toHaveBeenCalledOnce();
    expect(next.deleted).toEqual([]);
    expect(next.disposed).not.toHaveBeenCalled();
    await render('exit');
    expect(next.deleted).toEqual(['attachment-42']);
    expect(next.disposed).toHaveBeenCalledOnce();
    expect(newGadget).toHaveBeenCalledTimes(2);
  });

  it('releases upload ownership on failure and removes a ready file exactly once', async () => {
    await render();
    await attach();
    const owner = workspaces[0];
    await act(async () => owner.upload.reject(new Error('Upload rejected')));
    await render('exit');
    expect(owner.deleted).toEqual([]);
    expect(owner.disposed).toHaveBeenCalledOnce();

    await render();
    await attach();
    const next = workspaces.at(-1)!;
    await act(async () => next.upload.resolve({ id: 'attachment-42' }));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove attachment"]')!.click());
    expect(next.deleted).toEqual(['attachment-42']);
    await render('exit');
    expect(next.deleted).toEqual(['attachment-42']);
    expect(next.disposed).toHaveBeenCalledOnce();
  });

  it('does not acquire an attachment owner when file preparation finishes after teardown', async () => {
    await render();
    const bytes = deferred<ArrayBuffer>();
    await attach(bytes.promise);
    await render('exit');
    const creations = newGadget.mock.calls.length;
    await act(async () => bytes.resolve(new TextEncoder().encode('hello').buffer));
    expect(newGadget).toHaveBeenCalledTimes(creations);
    expect(workspaces.every(workspace => workspace.uploads.mock.calls.length === 0)).toBe(true);
    expect(workspaces.every(workspace => workspace.disposed.mock.calls.length === 1)).toBe(true);
  });

  it('releases ownership after a successful real composer send without deleting the sent attachment', async () => {
    await render();
    await attach();
    const owner = workspaces[0];
    await act(async () => owner.upload.resolve({ id: 'attachment-42' }));
    await send();
    expect(owner.chats).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(owner.deleted).toEqual([]);
    expect(owner.disposed).toHaveBeenCalledOnce();
    await render('exit');
    expect(owner.deleted).toEqual([]);
    expect(newGadget).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['reveal', 'resolve'], ['reveal', 'reject'], ['api', 'resolve'], ['api', 'reject'],
  ] as const)('keeps Finance creation scoped through %s and an overlapping late %s', async (kind, outcome) => {
    finance = true;
    localStorage.setItem('odie:selected-hub', 'finance');
    const old = new Workspace('old-finance');
    const next = new Workspace('new-finance');
    const oldMetadata = deferred<void>();
    const nextMetadata = deferred<void>();
    old.metadataDelay = oldMetadata.promise;
    next.metadataDelay = nextMetadata.promise;
    newGadget
      .mockImplementationOnce(() => new RpcStub(old) as unknown as RpcStub<Overseer>)
      .mockImplementationOnce(() => new RpcStub(next) as unknown as RpcStub<Overseer>);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await interrupt(kind);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(newGadget).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (outcome === 'resolve') oldMetadata.resolve();
      else oldMetadata.reject(new Error('Old Finance creation failed'));
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(old.disposed).toHaveBeenCalledOnce();
    expect(next.disposed).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    await act(async () => nextMetadata.resolve());
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: '/workspace/$id', params: { id: 'new-finance' }, search: {} });
    expect(next.disposed).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
