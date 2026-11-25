import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Tabs } from '@cloudflare/kumo'
import { Switch } from '@gadgets/ui'
import { Mascot, type MascotColor, type MascotEmotion } from '@/components/mascot/Mascot'
import { useHdrDisplay } from '@/hooks/useHdrDisplay'
import { Section } from './Section'

const EMOTIONS: MascotEmotion[] = ['idle', 'thinking', 'happy', 'sad', 'error', 'writing']
const COLORS: MascotColor[] = ['contrast', 'inverse', 'island', 'brand']

/** Every emotion at several sizes, coming and going. The large one can be played with; the others only show the state. */
export const MascotPreview = () => {
  const [emotion, setEmotion] = useState<MascotEmotion>('idle')
  const [shown, setShown] = useState(true)
  const [color, setColor] = useState<MascotColor>('contrast')
  const hdr = useHdrDisplay()

  return (
    <Section title="Mascot (each emotion at several sizes, coming and going; click the large one, or hold it while sad)">
      <div className="flex w-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Tabs
            size="sm"
            value={emotion}
            onValueChange={(value) => setEmotion(value as MascotEmotion)}
            tabs={EMOTIONS.map((value) => ({ value, label: value }))}
          />
          <Tabs
            size="sm"
            value={color}
            onValueChange={(value) => setColor(value as MascotColor)}
            tabs={COLORS.map((value) => ({ value, label: value }))}
          />
          <Switch label="Shown" checked={shown} onCheckedChange={setShown} />
        </div>
        <p className="text-sm text-kumo-subtle">
          {hdr
            ? 'This screen and browser can show HDR: click the large mascot while its sparkle is white (idle or thinking, in light for contrast, in dark for inverse and island, or brand) and the sparkle swells brighter than white, peaking halfway through the spin, and settles back. Pointing at it does nothing; happy and sad ones have no sparkle to spin.'
            : 'This screen or browser cannot show HDR, so the sparkle stays white. Try Chrome or Edge 136+, or Safari 26, on an HDR display (a MacBook Pro or Studio Display counts), with the system’s brightness above its lowest.'}
        </p>
        {/* Room below for the rain. Inverse is for on top of something drawn in contrast, island on the connection island. */}
        <div className={cn('flex items-end gap-12 rounded-3xl px-12 pt-12 pb-20 ring-1 ring-kumo-line', color === 'inverse' && 'bg-kumo-contrast', color === 'island' && 'bg-(--color-island)')}>
          <Mascot emotion={emotion} shown={shown} color={color} interactive className="w-40" />
          <Mascot emotion={emotion} shown={shown} color={color} className="w-16" />
          <Mascot emotion={emotion} shown={shown} color={color} className="w-8" />
          <Mascot emotion={emotion} shown={shown} color={color} className="w-5" />
        </div>
      </div>
    </Section>
  )
}
