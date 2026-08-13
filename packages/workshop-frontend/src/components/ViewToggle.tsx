import { List, GridFour } from '@phosphor-icons/react'

/**
 * Shared grid/list segmented toggle. Used on Gatekeepers and Outputs so view-switching looks and
 * behaves identically across the app.
 */
export default function ViewToggle({
  view,
  onChange,
}: {
  view: 'grid' | 'list'
  onChange: (view: 'grid' | 'list') => void
}) {
  const options = [
    { value: 'list' as const, Icon: List, label: 'List view' },
    { value: 'grid' as const, Icon: GridFour, label: 'Grid view' },
  ]
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-kumo-line bg-kumo-base p-0.5">
      {options.map(({ value, Icon, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-label={label}
          aria-pressed={view === value}
          className={`grid h-8 w-8 cursor-pointer place-items-center rounded-md transition-colors ${
            view === value
              ? 'bg-kumo-fill text-kumo-strong'
              : 'text-kumo-inactive hover:text-kumo-default'
          }`}
        >
          <Icon size={16} weight={view === value ? 'bold' : 'regular'} />
        </button>
      ))}
    </div>
  )
}
