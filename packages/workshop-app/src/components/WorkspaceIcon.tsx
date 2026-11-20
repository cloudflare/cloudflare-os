import type { CSSProperties } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import type { WorkspaceIconShape, WorkspaceLook } from '@/prefs/preferenceFields'
import { WORKSPACE_COLORS } from './workspaceLook'

export type WorkspaceIconProps = WorkspaceLook & {
  /** Two letters shown on the icon, e.g. a language code. */
  label: string
  /** The size for a button. Its letters are larger for the icon, so they stay legible. */
  small?: boolean
}

// Where the middle of the letters is, unless a shape says where its own are.
const LABEL = { x: 16, y: 17.2 }
// How far under the middle of capital letters their baseline is, as a share of their size.
const BASELINE = 0.363

type Shape = {
  /** Its outlines, each drawn over the ones before it. */
  layers: string[]
  /**
   * How light each layer is, from 0, the darkest, to 1, the lightest, which the letters are on.
   * Left out, they go evenly from 0 for the first layer to 1 for the last: lighter towards the
   * front.
   */
  shades?: number[]
  /** What is drawn on it as the letters are. */
  marks?: string
  /** Where the middle of the letters is: what looks like the middle of the layer they are on. */
  label?: { x: number; y: number }
  /** The size of the letters of a small icon, where there is not the room across it for the usual one. */
  smallLetters?: number
}

/**
 * Each shape, in a box of 32 by 30, at the size that has it weigh on the eye what the others do.
 * Every layer is rounded: a corner is only ever where one layer meets another.
 */
const SHAPES: Record<WorkspaceIconShape, Shape> = {
  folder: {
    layers: [
      'M0 6.33379C0 2.83573 2.83574 -1.49864e-06 6.3338 -1.49864e-06H6.60964C7.76897 -1.49864e-06 8.89848 0.367299 9.83607 1.04918C10.7737 1.73106 11.9032 2.09836 13.0625 2.09836H24C28.4183 2.09836 32 5.68008 32 10.0984V21.2834C32 25.7017 28.4183 29.2834 24 29.2834H8C3.58172 29.2834 0 25.7017 0 21.2834V6.33379Z',
      'M0 14.4826C0 10.0643 3.58172 6.48259 8 6.48259H24C28.4183 6.48259 32 10.0643 32 14.4826V21.3119C32 25.7302 28.4183 29.3119 24 29.3119H8C3.58172 29.3119 0 25.7302 0 21.3119V14.4826Z',
    ],
  },
  briefcase: {
    layers: [
      'M8 5A1.5 1.5 0 0 0 9.5 3.5V3.2A3.2 3.2 0 0 1 12.7 0H19.3A3.2 3.2 0 0 1 22.5 3.2V3.5A1.5 1.5 0 0 0 24 5A8 8 0 0 1 32 13V21.3A8 8 0 0 1 24 29.3H8A8 8 0 0 1 0 21.3V13A8 8 0 0 1 8 5ZM13.25 2.5A1.25 1.25 0 0 0 13.25 5H18.75A1.25 1.25 0 0 0 18.75 2.5H13.25Z',
      'M8 9.6H24A8 8 0 0 1 32 17.6V21.3A8 8 0 0 1 24 29.3H8A8 8 0 0 1 0 21.3V17.6A8 8 0 0 1 8 9.6Z',
    ],
    label: { x: 16, y: 18.8 },
  },
  notepad: {
    layers: [
      'M0 11.2A8 8 0 0 1 8 3.2A0.8 0.8 0 0 0 8.8 2.4V1.5A1.5 1.5 0 0 1 11.8 1.5V2.4A0.8 0.8 0 0 0 12.6 3.2H13.7A0.8 0.8 0 0 0 14.5 2.4V1.5A1.5 1.5 0 0 1 17.5 1.5V2.4A0.8 0.8 0 0 0 18.3 3.2H19.4A0.8 0.8 0 0 0 20.2 2.4V1.5A1.5 1.5 0 0 1 23.2 1.5V2.4A0.8 0.8 0 0 0 24 3.2A8 8 0 0 1 32 11.2V21.3A8 8 0 0 1 24 29.3H8A8 8 0 0 1 0 21.3V11.2Z',
      'M8 8.6H24A8 8 0 0 1 32 16.6V21.3A8 8 0 0 1 24 29.3H8A8 8 0 0 1 0 21.3V16.6A8 8 0 0 1 8 8.6Z',
    ],
    label: { x: 16, y: 18.3 },
  },
  stack: {
    layers: [
      'M11.2 0H20.8A6 6 0 0 1 26.8 6V12A2 2 0 0 1 24.8 14H7.2A2 2 0 0 1 5.2 12V6A6 6 0 0 1 11.2 0Z',
      'M9.6 3.5H22.4A7 7 0 0 1 29.4 10.5V16A2 2 0 0 1 27.4 18H4.6A2 2 0 0 1 2.6 16V10.5A7 7 0 0 1 9.6 3.5Z',
      'M8 7H24A8 8 0 0 1 32 15V21.3A8 8 0 0 1 24 29.3H8A8 8 0 0 1 0 21.3V15A8 8 0 0 1 8 7Z',
    ],
    label: { x: 16, y: 17.4 },
  },
  window: {
    layers: [
      'M8.4 0.73L23.6 0.73A7.6 7.6 0 0 1 31.2 8.33L31.2 20.97A7.6 7.6 0 0 1 23.6 28.57L8.4 28.57A7.6 7.6 0 0 1 0.8 20.97L0.8 8.33A7.6 7.6 0 0 1 8.4 0.73Z',
      'M8.4 7.95L23.6 7.95A7.6 7.6 0 0 1 31.2 15.55L31.2 20.97A7.6 7.6 0 0 1 23.6 28.57L8.4 28.57A7.6 7.6 0 0 1 0.8 20.97L0.8 15.55A7.6 7.6 0 0 1 8.4 7.95Z',
    ],
    marks: 'M8.69 4.44A1.23 1.23 0 1 1 6.22 4.44A1.23 1.23 0 0 1 8.69 4.44ZM12.68 4.44A1.23 1.23 0 1 1 10.21 4.44A1.23 1.23 0 0 1 12.68 4.44ZM16.66 4.44A1.23 1.23 0 1 1 14.2 4.44A1.23 1.23 0 0 1 16.66 4.44Z',
    label: { x: 16, y: 17.6 },
  },
  house: {
    layers: [
      'M0.8 14.51Q0.8 10.23 4.31 7.78L12.49 2.04Q16 -0.41 19.51 2.04L21.18 3.22A0.57 0.57 0 0 0 22.08 2.75L22.08 2.44A1.14 1.14 0 0 1 23.22 1.3L24.74 1.3A1.14 1.14 0 0 1 25.88 2.44L25.88 6.11A0.76 0.76 0 0 0 26.2 6.73L27.69 7.78Q31.2 10.23 31.2 14.51L31.2 20.97A7.6 7.6 0 0 1 23.6 28.57L8.4 28.57A7.6 7.6 0 0 1 0.8 20.97L0.8 14.51Z',
      'M0.8 18.69Q0.8 14.41 4.31 11.96L12.49 6.22Q16 3.77 19.51 6.22L27.69 11.96Q31.2 14.41 31.2 18.69L31.2 20.97A7.6 7.6 0 0 1 23.6 28.57L8.4 28.57A7.6 7.6 0 0 1 0.8 20.97L0.8 18.69Z',
    ],
    label: { x: 16, y: 17.6 },
  },
  building: {
    layers: [
      'M3.5 9.5H6.5A3.5 3.5 0 0 1 10 13V25.8A3.5 3.5 0 0 1 6.5 29.3H3.5A3.5 3.5 0 0 1 0 25.8V13A3.5 3.5 0 0 1 3.5 9.5ZM25.5 15H28.5A3.5 3.5 0 0 1 32 18.5V25.8A3.5 3.5 0 0 1 28.5 29.3H25.5A3.5 3.5 0 0 1 22 25.8V18.5A3.5 3.5 0 0 1 25.5 15Z',
      'M9 0H23A3.5 3.5 0 0 1 26.5 3.5V25.8A3.5 3.5 0 0 1 23 29.3H9A3.5 3.5 0 0 1 5.5 25.8V3.5A3.5 3.5 0 0 1 9 0Z',
      'M8.5 3.2H9.7A0.9 0.9 0 0 1 10.6 4.1V5.3A0.9 0.9 0 0 1 9.7 6.2H8.5A0.9 0.9 0 0 1 7.6 5.3V4.1A0.9 0.9 0 0 1 8.5 3.2ZM13.1 3.2H14.3A0.9 0.9 0 0 1 15.2 4.1V5.3A0.9 0.9 0 0 1 14.3 6.2H13.1A0.9 0.9 0 0 1 12.2 5.3V4.1A0.9 0.9 0 0 1 13.1 3.2ZM17.7 3.2H18.9A0.9 0.9 0 0 1 19.8 4.1V5.3A0.9 0.9 0 0 1 18.9 6.2H17.7A0.9 0.9 0 0 1 16.8 5.3V4.1A0.9 0.9 0 0 1 17.7 3.2ZM22.3 3.2H23.5A0.9 0.9 0 0 1 24.4 4.1V5.3A0.9 0.9 0 0 1 23.5 6.2H22.3A0.9 0.9 0 0 1 21.4 5.3V4.1A0.9 0.9 0 0 1 22.3 3.2ZM8.5 8H9.7A0.9 0.9 0 0 1 10.6 8.9V10.1A0.9 0.9 0 0 1 9.7 11H8.5A0.9 0.9 0 0 1 7.6 10.1V8.9A0.9 0.9 0 0 1 8.5 8ZM13.1 8H14.3A0.9 0.9 0 0 1 15.2 8.9V10.1A0.9 0.9 0 0 1 14.3 11H13.1A0.9 0.9 0 0 1 12.2 10.1V8.9A0.9 0.9 0 0 1 13.1 8ZM17.7 8H18.9A0.9 0.9 0 0 1 19.8 8.9V10.1A0.9 0.9 0 0 1 18.9 11H17.7A0.9 0.9 0 0 1 16.8 10.1V8.9A0.9 0.9 0 0 1 17.7 8ZM22.3 8H23.5A0.9 0.9 0 0 1 24.4 8.9V10.1A0.9 0.9 0 0 1 23.5 11H22.3A0.9 0.9 0 0 1 21.4 10.1V8.9A0.9 0.9 0 0 1 22.3 8ZM8.5 24H9.7A0.9 0.9 0 0 1 10.6 24.9V26.1A0.9 0.9 0 0 1 9.7 27H8.5A0.9 0.9 0 0 1 7.6 26.1V24.9A0.9 0.9 0 0 1 8.5 24ZM13.1 24H14.3A0.9 0.9 0 0 1 15.2 24.9V26.1A0.9 0.9 0 0 1 14.3 27H13.1A0.9 0.9 0 0 1 12.2 26.1V24.9A0.9 0.9 0 0 1 13.1 24ZM17.7 24H18.9A0.9 0.9 0 0 1 19.8 24.9V26.1A0.9 0.9 0 0 1 18.9 27H17.7A0.9 0.9 0 0 1 16.8 26.1V24.9A0.9 0.9 0 0 1 17.7 24ZM22.3 24H23.5A0.9 0.9 0 0 1 24.4 24.9V26.1A0.9 0.9 0 0 1 23.5 27H22.3A0.9 0.9 0 0 1 21.4 26.1V24.9A0.9 0.9 0 0 1 22.3 24Z',
    ],
    shades: [0, 1, 0],
    label: { x: 16, y: 17.5 },
  },
  bulb: {
    layers: [
      'M14.15 27L17.85 27A1.15 1.15 0 0 1 17.85 29.3L14.15 29.3A1.15 1.15 0 0 1 14.15 27Z',
      'M9.25 21.03A11.6 11.6 0 1 1 22.75 21.03A3 3 0 0 0 21.5 23.47L21.5 25.5A2.5 2.5 0 0 1 19 28L13 28A2.5 2.5 0 0 1 10.5 25.5L10.5 23.47A3 3 0 0 0 9.25 21.03Z',
      'M11.8 25.2L20.2 25.2A1.4 1.4 0 0 1 20.2 28L11.8 28A1.4 1.4 0 0 1 11.8 25.2Z',
      'M11 22.6L21 22.6A1.6 1.6 0 0 1 21 25.8L11 25.8A1.6 1.6 0 0 1 11 22.6Z',
    ],
    shades: [0, 1, 0.5, 0],
    label: { x: 16, y: 11.7 },
    smallLetters: 11,
  },
  rocket: {
    layers: [
      'M2.24 12.14A11.5 8 45 0 1 18.51 28.41A2.5 2.5 0 0 1 14.97 28.41L2.24 15.68A2.5 2.5 0 0 1 2.24 12.14ZM9.42 18.4L12.25 21.23A2 2 0 0 1 12.25 24.06L10.02 26.29A2 2 0 0 1 7.19 26.29L4.36 23.46A2 2 0 0 1 4.36 20.63L6.59 18.4A2 2 0 0 1 9.42 18.4Z',
      'M14.62 3.31C18.97 -1.04 26.64 -0.23 28.76 1.89C30.88 4.01 31.69 11.68 27.34 16.03L18.51 24.87A6 6 0 0 1 10.02 24.87L5.78 20.63A6 6 0 0 1 5.78 12.14L14.62 3.31Z',
      'M13.56 4.37A9 6 45 0 1 26.28 17.09L18.51 24.87A6 6 0 0 1 10.02 24.87L5.78 20.63A6 6 0 0 1 5.78 12.14L13.56 4.37Z',
    ],
    shades: [0, 0, 1],
    label: { x: 15.7, y: 14.9 },
    smallLetters: 10.5,
  },
  cloud: {
    layers: [
      'M15.5 17A5.8 5.8 0 0 1 14.13 5.56A1.4 1.4 0 0 0 15.11 4.71A7.4 7.4 0 0 1 29.38 6.93A1.4 1.4 0 0 0 29.95 7.97A5 5 0 0 1 27 17L15.5 17Z',
      'M6.8 29.3A6.8 6.8 0 0 1 4.96 15.95A1.6 1.6 0 0 0 6.06 14.88A8.3 8.3 0 0 1 20.54 12.19A1.6 1.6 0 0 0 21.88 12.81A6.4 6.4 0 0 1 28.38 17.52A1.6 1.6 0 0 0 29.12 18.49A5.8 5.8 0 0 1 26.2 29.3L6.8 29.3Z',
    ],
    label: { x: 15.7, y: 20.3 },
  },
  cone: {
    layers: [
      'M15 0L17 0Q19.5 0 20.43 2.32L28.97 23.68Q29.9 26 27.4 26L4.6 26Q2.1 26 3.03 23.68L11.57 2.32Q12.5 0 15 0Z',
      'M10.18 5.8L21.82 5.8L23.18 9.2L8.82 9.2Z',
      'M7.14 13.4L24.86 13.4L28.97 23.68Q29.9 26 27.4 26L4.6 26Q2.1 26 3.03 23.68Z',
      'M2.35 24.6L29.65 24.6A2.35 2.35 0 0 1 29.65 29.3L2.35 29.3A2.35 2.35 0 0 1 2.35 24.6Z',
    ],
    shades: [0, 1, 1, 0.5],
    label: { x: 16, y: 19.2 },
    smallLetters: 10.5,
  },
  robot: {
    layers: [
      'M14.889 3.663A2 2 0 1 1 17.111 3.663A0.7 0.7 0 0 0 16.8 4.245V8.2A0.8 0.8 0 0 1 15.2 8.2V4.245A0.7 0.7 0 0 0 14.889 3.663ZM2.6 13A2.6 2.6 0 0 1 5.2 15.6V18.4A2.6 2.6 0 0 1 0 18.4V15.6A2.6 2.6 0 0 1 2.6 13ZM29.4 13A2.6 2.6 0 0 1 32 15.6V18.4A2.6 2.6 0 0 1 26.8 18.4V15.6A2.6 2.6 0 0 1 29.4 13Z',
      'M10.6 6.6H21.4A8 8 0 0 1 29.4 14.6V21.3A8 8 0 0 1 21.4 29.3H10.6A8 8 0 0 1 2.6 21.3V14.6A8 8 0 0 1 10.6 6.6Z',
      'M11 10.6H21A6 6 0 0 1 27 16.6V20.8A6 6 0 0 1 21 26.8H11A6 6 0 0 1 5 20.8V16.6A6 6 0 0 1 11 10.6Z',
    ],
    label: { x: 16, y: 18.65 },
  },
}

// How much of the letters' colour is between the lightest layer and the darkest.
const FRONT_SHADE = 0.16

/**
 * A workspace's mark with a short label: a folder, or another `shape`. Until it is given a `color`
 * it is drawn in the colours of the viewer's own messages, so it is the page's opposite: black with
 * white letters in light, and the other way round in dark. In a colour it is the same in both, with
 * white letters.
 *
 * Its layers are told apart by a little of the letters' colour over them, and the letters are on
 * the lightest. White letters lighten, so they are over the layers a shape has as its lighter
 * ones. The dark letters of a white icon would darken those, so there they are over the others.
 */
export const WorkspaceIcon = ({ label, small, shape = 'folder', color = 'contrast' }: WorkspaceIconProps) => {
  const { layers, shades, marks, label: at = LABEL, smallLetters = 12 } = SHAPES[shape]
  const size = small ? smallLetters : 9.5
  return (
    <svg
      width={small ? 22 : 32}
      height={small ? 20.625 : 30}
      viewBox="0 0 32 30"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0', color === 'contrast' ? 'text-kumo-inverse' : 'text-(--color-workspace-ink)')}
    >
      {layers.map((layer, index) => {
        const shade = shades?.[index] ?? index / (layers.length - 1)
        return (
          <g key={layer}>
            <path d={layer} className={WORKSPACE_COLORS[color].fill} />
            <path
              d={layer}
              fill="currentColor"
              style={{ '--shade': FRONT_SHADE * shade, '--shade-behind': FRONT_SHADE * (1 - shade) } as CSSProperties}
              className={cn('[fill-opacity:var(--shade)]', color === 'contrast' && 'dark:[fill-opacity:var(--shade-behind)]')}
            />
          </g>
        )
      })}
      {marks && <path d={marks} fill="currentColor" />}
      <text x={at.x} y={at.y + BASELINE * size} textAnchor="middle" fontSize={size} fontWeight="600" fill="currentColor">
        {label}
      </text>
    </svg>
  )
}
