import { useState } from 'react'
import { Switch, Tabs } from '@cloudflare/kumo'
import { Mascot, type MascotEmotion } from '@/components/mascot/Mascot'
import { Section } from './Section'

const EMOTIONS: MascotEmotion[] = ['idle', 'thinking', 'happy', 'sad', 'error', 'loading']

/** Every emotion at several sizes, coming and going. The large one can be played with; the others only show the state. */
export const MascotPreview = () => {
  const [emotion, setEmotion] = useState<MascotEmotion>('idle')
  const [shown, setShown] = useState(true)

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
          <Switch label="Shown" checked={shown} onCheckedChange={setShown} />
        </div>
        {/* Room below for the rain. */}
        <div className="flex items-end gap-12 rounded-3xl px-12 pt-12 pb-20 ring-1 ring-kumo-line">
          <Mascot emotion={emotion} shown={shown} interactive className="w-40" />
          <Mascot emotion={emotion} shown={shown} className="w-16" />
          <Mascot emotion={emotion} shown={shown} className="w-9" />
          <Mascot emotion={emotion} shown={shown} className="w-5" />
        </div>
      </div>
    </Section>
  )
}
