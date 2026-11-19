import { describe, expect, it } from 'vitest'
import type { SearchEntry } from '@/blocks/SearchDialog'
import { suggestedEntries, type SuggestedContext } from './-appSearchSuggestions'

const entry = (key: string, group: string): SearchEntry => ({ key, group, title: key, icon: null, onSelect: () => {} })
const workspaces = Array.from({ length: 6 }, (_, index) => entry(`w${index}`, 'Workspaces'))
const pages = [entry('workspaces', 'Go to'), entry('library', 'Go to')]
const newChatOfItsOwn = entry('new-chat', 'Go to')
const model = entry('model', 'Models')
// The page that goes to the rest is listed with them, though it is found under Go to.
const settings = [entry('theme', 'Preferences'), entry('animations', 'Preferences'), entry('settings', 'Go to')]
const newChat = entry('new-here', 'Go to')
const invite = entry('invite', 'Workspace')
const chat: SuggestedContext = { kind: 'chat', newChat, invite: undefined }
const workspace: SuggestedContext = { kind: 'workspace', newChat, invite }
const keys = (entries: SearchEntry[]) => entries.map(({ key }) => key)
const offered = (context: SuggestedContext | undefined) => suggestedEntries({ workspaces, pages, newChat: newChatOfItsOwn, model, settings, context })

describe('suggestedEntries', () => {
  it('offers a new chat, three workspaces, the pages, then the model and the settings, in the order given', () => {
    expect(keys(offered(undefined))).toEqual(['new-chat', 'w0', 'w1', 'w2', 'workspaces', 'library', 'model', 'theme', 'animations', 'settings'])
  })

  it('has a new chat with no heading first, and the settings, under a heading of their own, below the pages', () => {
    const all = offered(undefined)
    expect(all.find(({ key }) => key === 'new-chat')).toMatchObject({ group: 'Actions', noHeading: true })
    expect(all.filter(({ group }) => group === 'Settings')).toHaveLength(4)
    expect(new Set(all.map(({ group }) => group))).toEqual(new Set(['Actions', 'Workspaces', 'Go to', 'Settings']))
  })

  it('has a new chat in the workspace, and the model, in a chat, in place of the new chat of its own, the model not with the settings', () => {
    const inChat = offered(chat)
    expect(keys(inChat)).toEqual(['new-here', 'model', 'w0', 'w1', 'w2', 'workspaces', 'library', 'theme', 'animations', 'settings'])
    expect(inChat.filter(({ key }) => key === 'new-here' || key === 'model').map(({ group, noHeading }) => [group, noHeading])).toEqual([['Actions', true], ['Actions', true]])
    expect(inChat.filter(({ key }) => key === 'model')).toHaveLength(1)
  })

  it('has a new chat in the workspace and inviting on its page, the model staying with the settings', () => {
    expect(keys(offered(workspace))).toEqual(['new-here', 'invite', 'w0', 'w1', 'w2', 'workspaces', 'library', 'model', 'theme', 'animations', 'settings'])
  })

  it('has the new chat of its own where the viewer may not start one in the workspace, and no inviting where they may not', () => {
    const cannot: SuggestedContext = { kind: 'workspace', newChat: undefined, invite: undefined }
    expect(keys(suggestedEntries({ workspaces, pages, newChat: newChatOfItsOwn, model, settings, context: cannot }))).toEqual(['new-chat', 'w0', 'w1', 'w2', 'workspaces', 'library', 'model', 'theme', 'animations', 'settings'])
  })

  it('has no new chat where the user is on the page that starts one, and starts with the workspaces', () => {
    expect(keys(suggestedEntries({ workspaces, pages, newChat: undefined, model, settings, context: undefined }))).toEqual(['w0', 'w1', 'w2', 'workspaces', 'library', 'model', 'theme', 'animations', 'settings'])
  })

  it('leaves out a model that is not offered, in a chat or not', () => {
    expect(keys(suggestedEntries({ workspaces, pages, newChat: newChatOfItsOwn, model: undefined, settings, context: chat }))).toEqual(['new-here', 'w0', 'w1', 'w2', 'workspaces', 'library', 'theme', 'animations', 'settings'])
    expect(keys(suggestedEntries({ workspaces, pages, newChat: newChatOfItsOwn, model: undefined, settings, context: undefined }))).toEqual(['new-chat', 'w0', 'w1', 'w2', 'workspaces', 'library', 'theme', 'animations', 'settings'])
  })

  it('leaves the entries as they are found by typing, which keep the part they are in', () => {
    offered(chat)
    offered(workspace)
    offered(undefined)
    expect([model, ...settings, newChat, invite, newChatOfItsOwn].map(({ group, noHeading }) => [group, noHeading])).toEqual([
      ['Models', undefined], ['Preferences', undefined], ['Preferences', undefined], ['Go to', undefined], ['Go to', undefined], ['Workspace', undefined], ['Go to', undefined],
    ])
  })

  it('has no workspaces to offer before they are read, and offers the rest', () => {
    expect(keys(suggestedEntries({ workspaces: [], pages, newChat: newChatOfItsOwn, model, settings, context: undefined }))).toEqual(['new-chat', 'workspaces', 'library', 'model', 'theme', 'animations', 'settings'])
  })
})
