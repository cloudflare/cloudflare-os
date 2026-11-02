import { describe, expect, it } from 'vitest'
import type {
  AiChatAuthorInfo,
  GadgetMetadataWithTimestamps,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { groupWorkspaces, type WorkspaceSection } from './groupWorkspaces'
import type { SpaceListings } from './useSpaceListings'

const ME: AiChatAuthorInfo = { type: 'user', id: 'me@example.com', name: 'Me' }
const ADA: AiChatAuthorInfo = { type: 'user', id: 'ada@example.com', name: 'Ada' }

const PERSONAL = { key: '~me', name: 'Me', kind: 'personal', owner: ME, role: 'admin' } as const
const ADAS = { key: '~ada', name: 'Ada', kind: 'personal', owner: ADA, role: 'use' } as const
const DESIGN = { key: 'design', name: 'Design', kind: 'team', role: 'use' } as const
const PLATFORM = { key: 'platform', name: 'Platform', kind: 'team', role: 'admin' } as const
const SPACES = [PERSONAL, ADAS, DESIGN, PLATFORM]

const DAY = new Date('2026-09-01T00:00:00Z')

const mine = (id: string, spaceKey?: string): GadgetMetadataWithTimestamps =>
  ({ id, title: id, created: DAY, lastActive: DAY, spaceKey })

const sharedWithMe = (id: string): GadgetMetadataWithTimestamps =>
  ({ id, title: id, created: DAY, lastActive: DAY, owner: ADA })

const listedBy = (owner: AiChatAuthorInfo, id: string): SpaceWorkspaceInfo =>
  ({ id, title: id, owner, created: DAY })

const ready = (...workspaces: SpaceWorkspaceInfo[]) => ({ status: 'ready', workspaces }) as const

const group = (gadgets: GadgetMetadataWithTimestamps[], listings: SpaceListings, spaces = SPACES) =>
  groupWorkspaces({ gadgets, spaces: [...spaces], listings, userId: ME.id })

// Each section as its name and its rows, a row as `kind:id`.
const layout = (sections: WorkspaceSection[]) => Object.fromEntries(sections.map(section => [
  section.kind === 'space' ? section.space.key : section.kind,
  section.rows.map(row => `${row.kind}:${row.id}`),
]))

describe('groupWorkspaces', () => {
  it('gives a row from the user’s list the entry its own section’s space lists it under', () => {
    const roadmap = { ...listedBy(ME, 'roadmap'), slug: 'roadmap' }
    const brief = { ...listedBy(ADA, 'brief'), slug: 'brief' }
    const sections = group(
      [mine('solo'), mine('roadmap', 'platform'), sharedWithMe('brief')],
      // `solo` is still listed by a space it has left, which is not where its row is.
      { design: ready(listedBy(ME, 'solo')), platform: ready(roadmap, brief) },
    )

    const entries = sections.flatMap(section => section.rows)
      .map(row => [row.id, row.kind === 'record' ? row.entry : row.workspace])
    expect(entries).toEqual([['solo', undefined], ['roadmap', roadmap], ['brief', brief]])
  })

  it('places the user’s own workspaces by their own record, whatever the listings say', () => {
    const sections = group(
      [mine('solo'), mine('roadmap', 'platform')],
      {
        // Still loading: the record alone places `roadmap`.
        // `solo` is listed by a space it has since left; `gone` is listed with no record left.
        design: ready(listedBy(ME, 'solo'), listedBy(ME, 'gone')),
      },
    )

    expect(layout(sections)).toEqual({
      personal: ['record:solo'],
      '~ada': [],
      design: [],
      platform: ['record:roadmap'],
    })
    expect(sections.find(section => section.kind === 'personal'))
      .toMatchObject({ space: PERSONAL })
  })

  it('shows the user’s own workspace once while it is not known who the user is', () => {
    // Nothing tells whose a listing's entry is then, but the user's own list has their record.
    const sections = groupWorkspaces({
      gadgets: [mine('roadmap', 'platform')],
      spaces: [...SPACES],
      listings: { platform: ready(listedBy(ME, 'roadmap')) },
      userId: undefined,
    })

    expect(layout(sections)).toMatchObject({ platform: ['record:roadmap'] })
  })

  it('shows another member’s workspace as a listed row of the space that lists it', () => {
    const sections = group([mine('roadmap', 'platform')], {
      platform: ready(listedBy(ADA, 'adas-notes'), listedBy(ME, 'roadmap')),
      '~ada': ready(listedBy(ADA, 'adas-own')),
    })

    expect(layout(sections)).toMatchObject({
      platform: ['record:roadmap', 'listed:adas-notes'],
      '~ada': ['listed:adas-own'],
    })
  })

  it('shows a shared workspace that a space lists in that space, with the user’s record of it', () => {
    const sections = group([sharedWithMe('adas-notes'), sharedWithMe('adas-other')], {
      platform: ready(listedBy(ADA, 'adas-notes')),
    })

    expect(layout(sections)).toMatchObject({
      platform: ['record:adas-notes'],
      shared: ['record:adas-other'],
    })
  })

  it('keeps a space whose listing failed, with the user’s own workspaces in it', () => {
    const sections = group([mine('roadmap', 'platform'), sharedWithMe('adas-notes')], {
      platform: { status: 'failed' },
      design: { status: 'refused' },
    })

    expect(sections.filter(section => section.kind === 'space').map(section => section.listing))
      .toEqual(['loading', 'refused', 'failed'])
    // What the failed listing would have claimed stays where it is known from.
    expect(layout(sections)).toMatchObject({
      platform: ['record:roadmap'],
      shared: ['record:adas-notes'],
    })
  })

  it('shows a workspace two spaces list in the first of them only', () => {
    const sections = group([], {
      design: ready(listedBy(ADA, 'moving')),
      platform: ready(listedBy(ADA, 'moving')),
    })

    expect(layout(sections)).toMatchObject({ design: ['listed:moving'], platform: [] })
  })

  it('keeps the user’s workspace in a space they are no longer in, apart from their personal ones', () => {
    const sections = group([mine('left-behind', 'former')], {})

    expect(layout(sections)).toMatchObject({ personal: [], elsewhere: ['record:left-behind'] })
  })

  it('leaves out the sections for other spaces’ leftovers and shared workspaces when they are empty', () => {
    expect(group([mine('solo')], {}, [PERSONAL]).map(section => section.kind)).toEqual(['personal'])
  })

  it('puts the rows from the user’s list first, in list order, then the listed ones', () => {
    const sections = group(
      [sharedWithMe('pinned-shared'), mine('roadmap', 'platform')],
      { platform: ready(listedBy(ADA, 'newest'), listedBy(ADA, 'pinned-shared'), listedBy(ADA, 'older')) },
    )

    expect(layout(sections).platform)
      .toEqual(['record:pinned-shared', 'record:roadmap', 'listed:newest', 'listed:older'])
  })

  it('shows every workspace exactly once', () => {
    const gadgets = [
      mine('solo'), mine('roadmap', 'platform'), mine('left-behind', 'former'),
      sharedWithMe('adas-notes'), sharedWithMe('adas-other'),
    ]
    const sections = group(gadgets, {
      '~ada': ready(listedBy(ADA, 'adas-own'), listedBy(ADA, 'adas-notes')),
      design: ready(listedBy(ADA, 'adas-notes'), listedBy(ADA, 'moving'), listedBy(ME, 'solo')),
      platform: ready(listedBy(ME, 'roadmap'), listedBy(ADA, 'moving')),
    })

    const shown = sections.flatMap(section => section.rows.map(row => row.id)).toSorted()
    expect(shown).toEqual([
      'adas-notes', 'adas-other', 'adas-own', 'left-behind', 'moving', 'roadmap', 'solo',
    ])
  })
})
