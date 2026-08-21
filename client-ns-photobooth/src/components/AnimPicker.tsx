import tw from 'twin.macro'
import { useStore } from '@nanostores/preact'
import { GIF_OPTIONS, GifOption, qrModeEnabled, selectedGif } from '../store'
import owlThumb from '../assets/owl_anim/owl_idle_new.gif'
import batThumb from '../assets/Bat_anim/Bat_rest.png'
import globeThumb from '../assets/globe_anim/globe.gif'
import laptopThumb from '../assets/laptop_anim/laptop.gif'
import droneThumb from '../assets/drone_anim/drone.gif'
import scubaThumb from '../assets/cat_anim/scuba.gif'
import clownThumb from '../assets/Clown/clownicon.jpg'
import pigThumb from '../assets/Pig/Pig_icon.jpg'
import pigNoseThumb from '../assets/Pignose/Pignose_icon.jpg'

const THUMBS: Partial<Record<GifOption, string>> = {
  owl: owlThumb,
  bat: batThumb,
  globe: globeThumb,
  laptop: laptopThumb,
  drone: droneThumb,
  scuba: scubaThumb,
  clown: clownThumb,
  pig: pigThumb,
  pignose: pigNoseThumb,
}

/** side strip of thumbnail buttons for switching the active animation without opening settings */
export function AnimPicker() {
  const current = useStore(selectedGif)
  const qrMode = useStore(qrModeEnabled)

  // The character picker is meaningless in QR mode — animations there are
  // triggered by which QR code is shown to the camera (see QR_GIF_MAP in
  // Display.tsx), not by picking one here.
  if (qrMode) return null

  return (
    <div tw='fixed right-3 top-1/2 -translate-y-1/2 z-40 flex flex-col gap-2'>
      {Object.entries(GIF_OPTIONS).map(([key, label]) => {
        const option = key as GifOption
        const thumb = THUMBS[option]
        const active = option === current
        return (
          <button
            key={option}
            title={label}
            onClick={() => selectedGif.set(option)}
            tw='w-14 h-14 rounded-lg overflow-hidden border-2 flex items-center justify-center bg-gray-300 transition-all duration-150'
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
