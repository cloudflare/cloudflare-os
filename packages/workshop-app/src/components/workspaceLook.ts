/** What a workspace's icon can be drawn as, each with its name. The folder is first: it is the one until another is chosen. */
export const WORKSPACE_SHAPES = {
  folder: 'Folder',
  briefcase: 'Briefcase',
  notepad: 'Notepad',
  stack: 'Stack',
  window: 'Window',
  house: 'House',
  building: 'Building',
  rocket: 'Rocket',
  cloud: 'Cloud',
  cone: 'Traffic cone',
  bulb: 'Light bulb',
  robot: 'Robot',
} as const

export type WorkspaceShape = keyof typeof WORKSPACE_SHAPES

/**
 * The colours a workspace's icon can be drawn in, each with its name and the class that fills with
 * it. `contrast` is first: the page's opposite, which the icon is in until another is chosen. The
 * rest are `theme.css`'s.
 */
export const WORKSPACE_COLORS = {
  contrast: { name: 'Default', fill: 'fill-kumo-contrast' },
  red: { name: 'Red', fill: 'fill-(--color-workspace-red)' },
  orange: { name: 'Orange', fill: 'fill-(--color-workspace-orange)' },
  green: { name: 'Green', fill: 'fill-(--color-workspace-green)' },
  teal: { name: 'Teal', fill: 'fill-(--color-workspace-teal)' },
  blue: { name: 'Blue', fill: 'fill-(--color-workspace-blue)' },
  purple: { name: 'Purple', fill: 'fill-(--color-workspace-purple)' },
  pink: { name: 'Pink', fill: 'fill-(--color-workspace-pink)' },
} as const

export type WorkspaceColor = keyof typeof WORKSPACE_COLORS

/** How a workspace's icon is drawn: as what, and in which colour. What is left out is the first of each. */
export type WorkspaceLook = { shape?: WorkspaceShape; color?: WorkspaceColor }

/** The shapes, in the order they are offered in. */
export const workspaceShapes = Object.keys(WORKSPACE_SHAPES) as WorkspaceShape[]

/** The colours, in the order they are offered in. */
export const workspaceColors = Object.keys(WORKSPACE_COLORS) as WorkspaceColor[]

export const isWorkspaceShape = (value: unknown): value is WorkspaceShape => typeof value === 'string' && Object.hasOwn(WORKSPACE_SHAPES, value)

export const isWorkspaceColor = (value: unknown): value is WorkspaceColor => typeof value === 'string' && Object.hasOwn(WORKSPACE_COLORS, value)
