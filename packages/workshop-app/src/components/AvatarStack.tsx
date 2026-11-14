import { Avatar } from './Avatar'

export type AvatarStackProps = {
  people: { id: string; name: string; src?: string }[]
  /** What they have in common, as the group's accessible name: "Also here". */
  'aria-label': string
}

// More than this, and the last place says how many more there are.
const SHOWN = 3

/** A few people's pictures, overlapping, for who is there. */
export const AvatarStack = ({ people, 'aria-label': label }: AvatarStackProps) => {
  const shown = people.length > SHOWN ? people.slice(0, SHOWN - 1) : people
  const more = people.length - shown.length

  return (
    <span role="group" aria-label={label} className="flex items-center -space-x-1.5">
      {shown.map(({ id, name, src }) => (
        <span key={id} title={name} className="rounded-full ring-2 ring-kumo-base">
          <Avatar name={name} src={src} />
        </span>
      ))}
      {more > 0 && (
        <span
          role="img"
          aria-label={`${more} more`}
          className="inline-flex size-7 items-center justify-center rounded-full bg-kumo-tint text-xs font-medium text-kumo-subtle tabular-nums ring-2 ring-kumo-base"
        >
          +{more}
        </span>
      )}
    </span>
  )
}
