import tw from 'twin.macro'
import { useStore } from '@nanostores/preact'
import {
  BANNER_LOGOS,
  BannerLogo,
  burstModeEnabled,
  qrModeEnabled,
  selectedBannerLogo,
} from '../store'

/** Compact quick-access controls pinned top-right, alongside the AnimPicker
 * strip (top-center) — lets Banner Logo and Burst Mode be changed without
 * opening the full Settings panel. Same underlying store values as
 * Settings.tsx's BannerLogoSelect / "Enable Burst Mode" SwitchRow, just
 * reimplemented compactly rather than shared: those are sized for a
 * full-width settings list, this needs to fit in a HUD corner. */
export function TopControls() {
  const qrMode = useStore(qrModeEnabled)
  const bannerLogo = useStore(selectedBannerLogo)
  const burstOn = useStore(burstModeEnabled)

  // Same reasoning as AnimPicker/OcFusionPicker: both controls are
  // meaningless in QR mode (banner logo still shows, but there's nothing
  // here worth exposing mid-QR-session; keeps this consistent with the
  // other HUD pickers hiding together).
  if (qrMode) return null

  return (
    <div tw='fixed top-3 right-3 z-40 flex items-center gap-3 bg-gray-900/80 border border-gray-700 rounded-lg px-3 py-2'>
      <select
        value={bannerLogo}
        onChange={(e) => {
          const target = e.target as HTMLSelectElement
          selectedBannerLogo.set(target.value as BannerLogo)
          // A focused <select> can swallow the next Space press into
          // reopening its own dropdown instead of it reaching the
          // window-level 'Space' keybind that takes a photo (see
          // useKeybind in KeybindBtn.tsx — it never even sees the
          // keydown, since it's consumed by the native popup). Blur
          // immediately so focus doesn't linger here after a choice.
          target.blur()
        }}
        tw='bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1 rounded focus:outline-none focus:border-blue-500'
        title='Banner Logo'
      >
        {Object.entries(BANNER_LOGOS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>

      <label tw='flex items-center gap-2 cursor-pointer select-none'>
        <span tw='text-xs text-gray-300'>Burst</span>
        <button
          role='switch'
          aria-checked={burstOn}
          title='Enable Burst Mode'
          tw='relative w-10 h-[22px] rounded-full transition-colors duration-200 focus:outline-none flex-shrink-0'
          css={burstOn ? tw`bg-blue-600` : tw`bg-gray-600`}
          onClick={(e) => {
            burstModeEnabled.set(!burstOn)
            // Same reasoning as the select above — don't leave a focused
            // control sitting in the HUD that could intercept the next
            // Space press meant for taking a photo.
            ;(e.target as HTMLButtonElement).blur()
          }}
        >
          <span
            tw='absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow transition-transform duration-200'
            css={burstOn && tw`translate-x-[18px]`}
          />
        </button>
      </label>
    </div>
  )
}
