import tw from 'twin.macro'
import { useStore } from '@nanostores/preact'
import { GIF_OPTIONS, qrModeEnabled, selectedGifs } from '../store'
import ocfusionThumb from '../assets/OC_Fusion/OC_FUSION.png'

// Kept in sync with AnimPicker's own MAX_SELECTED — both pickers toggle the
// same selectedGifs list, so the limit has to agree or one picker could
// allow a selection the other would refuse.
const MAX_SELECTED = 5

const OPTION = 'ocfusion' as const
const LABEL = GIF_OPTIONS[OPTION]

/** Standalone bottom-right toggle for OC Fusion, split out from the main
 * top-strip AnimPicker on request — same toggle/limit behaviour, own corner. */
export function OcFusionPicker() {
  const current = useStore(selectedGifs)
  const qrMode = useStore(qrModeEnabled)

  // Same reasoning as AnimPicker: character pickers are meaningless in QR mode.
  if (qrMode) return null

  const active = current.includes(OPTION)
  const atLimit = !active && current.length >= MAX_SELECTED

  return (
    <div tw='fixed bottom-3 right-3 z-40'>
      <button
        title={atLimit ? `${LABEL} (limit of ${MAX_SELECTED} reached)` : LABEL}
        disabled={atLimit}
        onClick={() => {
          if (current.includes(OPTION)) {
            selectedGifs.set(current.filter((o) => o !== OPTION))
          } else if (current.length < MAX_SELECTED) {
            selectedGifs.set([...current, OPTION])
          }
        }}
        tw='w-14 h-14 rounded-lg overflow-hidden border-2 flex items-center justify-center bg-gray-300 transition-all duration-150 disabled:(opacity-25 cursor-not-allowed)'
        css={
          active
            ? tw`border-blue-500 opacity-100`
            : tw`border-transparent opacity-50 hover:opacity-90`
        }
      >
        <img src={ocfusionThumb} tw='w-full h-full object-contain pointer-events-none' />
      </button>
    </div>
  )
}
