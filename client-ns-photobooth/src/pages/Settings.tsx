import { useStore } from '@nanostores/preact'
import { useEffect, useRef, useState } from 'react'
import tw from 'twin.macro'
import { WritableAtom } from 'nanostores'
import { useKeybind } from '../components'
import {
  GIF_OPTIONS,
  GifOption,
  bannerEnabled,
  burstCount,
  burstIntervalSec,
  burstModeEnabled,
  camSize,
  canvasSize,
  debugEnabled,
  multiTarget,
  offlineOnly,
  cameraInitialized,
  photoCountdownSec,
  pictures,
  pointerEnabled,
  qrDroneLocked,
  qrOwlLocked,
  qrBatLocked,
  qrGlobeLocked,
  qrClownLocked,
  qrPigNoseLocked,
  qrBatEarsLocked,
  qrOrdloLocked,
  qrModeEnabled,
  router,
  selectedGifs,
  textureCache,
} from '../store'

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div tw='flex flex-col gap-2 py-4 border-b border-gray-800 last:border-0'>
      <p tw='text-[10px] font-semibold uppercase tracking-widest text-gray-500'>{title}</p>
      {children}
    </div>
  )
}

function SwitchRow({ label, boolVar }: { label: string; boolVar: WritableAtom }) {
  const value = useStore(boolVar)
  return (
    <div tw='flex items-center justify-between py-0.5'>
      <span tw='text-sm text-gray-300'>{label}</span>
      <button
        role='switch'
        aria-checked={value}
        tw='relative w-10 h-[22px] rounded-full transition-colors duration-200 focus:outline-none flex-shrink-0'
        css={value ? tw`bg-blue-600` : tw`bg-gray-600`}
        onClick={() => boolVar.set(!value)}
      >
        <span
          tw='absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow transition-transform duration-200'
          css={value && tw`translate-x-[18px]`}
        />
      </button>
    </div>
  )
}

/** Dropdown that opens into a checkbox list — lets several animations be
 * selected at once (see selectedGifs) while still collapsing to a single
 * closed control like a normal dropdown. */
function AnimMultiSelect() {
  const gifOptions = useStore(selectedGifs)
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

  const options = Object.entries(GIF_OPTIONS).filter(([key]) => key !== 'none')
  const summary = gifOptions.length === 0
    ? 'No animation'
    : gifOptions.map((o) => GIF_OPTIONS[o]).join(', ')

  return (
    <div ref={rootRef} tw='relative flex flex-col gap-1'>
      <span tw='text-xs text-gray-500'>Animation GIF</span>
      <button
        type='button'
        tw='bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-blue-500 text-left truncate flex items-center justify-between gap-2'
        onClick={() => setOpen((o) => !o)}
      >
        <span tw='truncate'>{summary}</span>
        <span tw='text-gray-500 flex-shrink-0'>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div tw='absolute top-full left-0 right-0 mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto p-1'>
          {options.map(([key, label]) => {
            const option = key as GifOption
            const checked = gifOptions.includes(option)
            return (
              <label
                key={key}
                tw='flex items-center gap-2 text-sm text-gray-300 px-2 py-1.5 rounded hover:bg-gray-700 cursor-pointer'
              >
                <input
                  type='checkbox'
                  checked={checked}
                  onChange={() =>
                    selectedGifs.set(
                      checked
                        ? gifOptions.filter((o) => o !== option)
                        : [...gifOptions, option],
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

function ResRow({
  label,
  value,
  setter,
}: {
  label: string
  value: { width: number; height: number }
  setter: (v: { width: number; height: number }) => void
}) {
  const widthRef = useRef<HTMLInputElement>(null)
  const heightRef = useRef<HTMLInputElement>(null)
  return (
    <div tw='flex flex-col gap-1'>
      <span tw='text-xs text-gray-500'>{label}</span>
      <div tw='flex items-center gap-2'>
        <input
          ref={widthRef}
          tw='w-16 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded text-center focus:outline-none focus:border-blue-500'
          type='number'
          min={0}
          max={3840}
          defaultValue={value.width}
        />
        <span tw='text-gray-500 text-sm'>×</span>
        <input
          ref={heightRef}
          tw='w-16 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded text-center focus:outline-none focus:border-blue-500'
          type='number'
          min={0}
          max={2160}
          defaultValue={value.height}
        />
        <button
          tw='flex-1 bg-gray-700 hover:bg-gray-600 text-white text-sm py-1.5 rounded transition-colors'
          onClick={() => {
            const w = parseInt(widthRef.current?.value ?? '0')
            const h = parseInt(heightRef.current?.value ?? '0')
            setter({ width: w, height: h })
          }}
        >
          Set
        </button>
      </div>
    </div>
  )
}


function NumberRow({
  label,
  value,
  setter,
  min = 1,
  max = 30,
}: {
  label: string
  value: number
  setter: (v: number) => void
  min?: number
  max?: number
}) {
  return (
    <div tw='flex items-center justify-between py-0.5'>
      <span tw='text-sm text-gray-300'>{label}</span>
      <input
        tw='w-16 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded text-center focus:outline-none focus:border-blue-500'
        type='number'
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = parseInt((e.target as HTMLInputElement).value)
          if (!isNaN(v)) setter(Math.max(min, Math.min(max, v)))
        }}
      />
    </div>
  )
}

export default function Settings() {
  const [shown, setShown] = useState(false)
  const canvasRes = useStore(canvasSize)
  const camRes = useStore(camSize)
  const burstOn = useStore(burstModeEnabled)
  const burstN = useStore(burstCount)
  const burstSec = useStore(burstIntervalSec)
  const countdownSec = useStore(photoCountdownSec)
  const qrMode = useStore(qrModeEnabled)

  useKeybind('KeyD', () => debugEnabled.set(!debugEnabled.get()))
  useKeybind('KeyS', () => setShown((s) => !s))

  return (
    <>
      <button
        tw='fixed top-5 left-5 z-50 w-10 h-10 flex items-center justify-center text-white bg-black bg-opacity-60 rounded-lg opacity-0 hover:opacity-100 transition-opacity text-xl leading-none'
        onClick={() => setShown(!shown)}
      >
        ☰
      </button>

      {shown && (
        <div
          tw='fixed inset-0 z-40 bg-black bg-opacity-40'
          onClick={() => setShown(false)}
        />
      )}

      <div
        tw='fixed top-0 left-0 h-full w-72 z-50 bg-gray-900 text-white flex flex-col shadow-2xl transition-transform duration-300'
        css={!shown ? tw`-translate-x-full` : tw`translate-x-0`}
      >
        <div tw='flex items-center justify-between px-5 py-4 border-b border-gray-800'>
          <h2 tw='text-base font-semibold tracking-wide'>Settings</h2>
          <button
            tw='text-gray-400 hover:text-white transition-colors text-lg leading-none'
            onClick={() => setShown(false)}
          >
            ✕
          </button>
        </div>

        <div tw='flex-1 overflow-y-auto px-5'>
          <Section title='Connection'>
            <SwitchRow label='Disable Online Features' boolVar={offlineOnly} />
          </Section>

          <Section title='Display'>
            <ResRow label='Canvas Size' value={canvasRes} setter={canvasSize.set} />
            <ResRow label='Camera Size' value={camRes} setter={camSize.set} />
          </Section>

          <Section title='Capture'>
            <NumberRow
              label='Countdown before shot (s)'
              value={countdownSec}
              setter={photoCountdownSec.set}
              min={0}
              max={15}
            />
            <SwitchRow label='Enable Burst Mode' boolVar={burstModeEnabled} />
            {burstOn && (
              <>
                <NumberRow
                  label='Photos per Burst'
                  value={burstN}
                  setter={burstCount.set}
                  min={1}
                  max={12}
                />
                <NumberRow
                  label='Interval between Shots (s)'
                  value={burstSec}
                  setter={burstIntervalSec.set}
                  min={1}
                  max={10}
                />
              </>
            )}
          </Section>

          <Section title='Animation'>
            {!qrMode && <AnimMultiSelect />}
            {!qrMode && <SwitchRow label='Multi-Person Tracking' boolVar={multiTarget} />}
            <SwitchRow label='Banner Animation' boolVar={bannerEnabled} />
            <SwitchRow label='Arrow Pointer' boolVar={pointerEnabled} />
            <SwitchRow label='Debug Animation' boolVar={debugEnabled} />
            <SwitchRow label='QR Code Mode' boolVar={qrModeEnabled} />
            {qrMode && (
              <button
                tw='w-full text-sm py-2 px-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-left transition-colors'
                onClick={() => {
                  qrDroneLocked.set(false)
                  qrOwlLocked.set(false)
                  qrBatLocked.set(false)
                  qrGlobeLocked.set(false)
                  qrClownLocked.set(false)
                  qrPigNoseLocked.set(false)
                  qrBatEarsLocked.set(false)
                  qrOrdloLocked.set(false)
                }}
              >
                Reset Animation
              </button>
            )}
          </Section>

          <Section title='Actions'>
            <button
              tw='w-full text-sm py-2 px-3 bg-red-900 hover:bg-red-800 text-white rounded-lg text-left transition-colors'
              onClick={() => {
                pictures.set([])
                textureCache.set({})
                cameraInitialized.set(false)
                router.open('/')
              }}
            >
              Reset Application
            </button>
          </Section>
        </div>

        
      </div>
    </>
  )
}
