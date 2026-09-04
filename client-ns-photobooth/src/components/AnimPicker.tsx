import tw from 'twin.macro'
import { useStore } from '@nanostores/preact'
import {
  GIF_OPTIONS,
  GifOption,
  MAX_SELECTED,
  canSelect,
  conflictingWith,
  qrModeEnabled,
  selectedGifs,
} from '../store'
import owlThumb from '../assets/owl_anim/owl_idle_new.gif'
import batThumb from '../assets/Bat_anim/Bat_rest.png'
import globeThumb from '../assets/globe_anim/globe.gif'
import droneThumb from '../assets/drone_anim/drone.gif'
import scubaThumb from '../assets/cat_anim/scuba.gif'
import pigNoseThumb from '../assets/Pignose/Pignose_icon.jpg'
import batEarsThumb from '../assets/batears/batearsicon.png'
import clownWigNoseThumb from '../assets/ClownWigNose/ClownWig.webp'
import sunglassesThumb from '../assets/Sunglasses/Sunglasses.png'
import mustacheThumb from '../assets/Mustache/mustache.png'

const THUMBS: Partial<Record<GifOption, string>> = {
  owl: owlThumb,
  bat: batThumb,
  globe: globeThumb,
  drone: droneThumb,
  scuba: scubaThumb,
  pignose: pigNoseThumb,
  batears: batEarsThumb,
  clownwignose: clownWigNoseThumb,
  sunglasses: sunglassesThumb,
  mustache: mustacheThumb,
}

/** top strip of thumbnail buttons for toggling active animations (multiple can
 * be on at once, all stacked on the same tracked person) without opening settings */
export function AnimPicker() {
  const current = useStore(selectedGifs)
  const qrMode = useStore(qrModeEnabled)

  // The character picker is meaningless in QR mode — animations there are
  // triggered by which QR code is shown to the camera (see QR_GIF_MAP in
  // Display.tsx), not by picking one here.
  if (qrMode) return null

  return (
    <div tw='fixed top-3 left-1/2 -translate-x-1/2 z-40 flex flex-row flex-wrap justify-center gap-2 max-w-[95vw]'>
      {/* OC Fusion has its own standalone picker (OcFusionPicker, bottom-right) — skip it here. */}
      {Object.entries(GIF_OPTIONS).filter(([key]) => key !== 'ocfusion').map(([key, label]) => {
        const option = key as GifOption
        const thumb = THUMBS[option]
        const active = option === 'none' ? current.length === 0 : current.includes(option)
        // 'none' is a clear-all, never itself selectable, so it is exempt.
        const blocked = option !== 'none' && !canSelect(current, option)
        // Say WHICH rule blocked it: a greyed-out button with no explanation
        // reads as broken. Conflicts are named, since "limit reached" would be
        // actively misleading when only two characters are on.
        const clash = option === 'none' ? undefined : conflictingWith(current, option)
        const why = clash
          ? `${label} (cannot be used with ${GIF_OPTIONS[clash]})`
          : `${label} (limit of ${MAX_SELECTED} reached)`
        return (
          <button
            key={option}
            title={blocked ? why : label}
            disabled={blocked}
            onClick={() => {
              if (option === 'none') {
                selectedGifs.set([])
              } else if (current.includes(option)) {
                selectedGifs.set(current.filter((o) => o !== option))
              } else if (canSelect(current, option)) {
                selectedGifs.set([...current, option])
              }
            }}
            tw='w-14 h-14 rounded-lg overflow-hidden border-2 flex items-center justify-center bg-gray-300 transition-all duration-150 disabled:(opacity-25 cursor-not-allowed)'
            css={
              active
                ? tw`border-blue-500 opacity-100`
                : tw`border-transparent opacity-50 hover:opacity-90`
            }
          >
            {thumb ? (
              <img src={thumb} tw='w-full h-full object-contain pointer-events-none' />
            ) : (
              <span tw='text-black text-[10px] text-center px-1 leading-tight pointer-events-none'>
                {label}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
