import { useEffect, useRef, useState } from 'react'
import tw from 'twin.macro'
import { useStore } from '@nanostores/preact'
import {
  BANNER_LOGOS,
  BANNER_LOGO_ORDER,
  BannerLogo,
  burstModeEnabled,
  qrModeEnabled,
  selectedBannerLogo,
} from '../store'

/** Compact dropdown-that-opens-into-checkboxes for the banner logo, so
 * several can be picked at once (see selectedBannerLogo) from the HUD corner
 * without opening full Settings. Same checkbox-list idea as Settings.tsx's
 * LogoMultiSelect, just reimplemented compactly — that one is sized for a
 * full-width settings list, this needs to fit in a HUD corner. */
function BannerLogoQuickSelect() {
  const selected = useStore(selectedBannerLogo)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  // BANNER_LOGO_ORDER, not Object.entries(BANNER_LOGOS) - see its comment in
  // store.ts for why '11' can't just be moved around the object literal.
  const entries = BANNER_LOGO_ORDER.map((key): [BannerLogo, string] => [key, BANNER_LOGOS[key]])
  const summary = selected.length === 0
    ? 'No logo'
    : selected.map((k) => BANNER_LOGOS[k]).join(', ')

  return (
    <div ref={rootRef} tw='relative'>
      <button
        type='button'
        title='Banner Logo'
        tw='bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1 rounded focus:outline-none focus:border-blue-500 max-w-[8rem] truncate'
        onClick={() => setOpen((o) => !o)}
      >
        {summary}
      </button>
      {open && (
        <div tw='absolute top-full right-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto p-1 min-w-[8rem]'>
          {entries.map(([key, label]) => {
            const checked = selected.includes(key)
            return (
              <label
                key={key}
                tw='flex items-center gap-2 text-sm text-gray-300 px-2 py-1.5 rounded hover:bg-gray-700 cursor-pointer whitespace-nowrap'
              >
                <input
                  type='checkbox'
                  checked={checked}
                  onChange={() =>
                    selectedBannerLogo.set(
                      checked ? selected.filter((o) => o !== key) : [...selected, key],
                    )
                  }
                />
                {label}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Compact quick-access controls pinned top-right, alongside the AnimPicker
 * strip (top-center) — lets Banner Logo and Burst Mode be changed without
 * opening the full Settings panel. Same underlying store values as
 * Settings.tsx's BannerLogoSelect / "Enable Burst Mode" SwitchRow, just
 * reimplemented compactly rather than shared: those are sized for a
 * full-width settings list, this needs to fit in a HUD corner. */
export function TopControls() {
  const qrMode = useStore(qrModeEnabled)
  const burstOn = useStore(burstModeEnabled)

  // Same reasoning as AnimPicker/OcFusionPicker: both controls are
  // meaningless in QR mode (banner logo still shows, but there's nothing
  // here worth exposing mid-QR-session; keeps this consistent with the
  // other HUD pickers hiding together).
  if (qrMode) return null

  return (
    <div tw='fixed top-3 right-3 z-40 flex items-center gap-3 bg-gray-900/80 border border-gray-700 rounded-lg px-3 py-2'>
      <BannerLogoQuickSelect />

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
