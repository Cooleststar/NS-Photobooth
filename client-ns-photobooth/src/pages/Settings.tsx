import { useStore } from '@nanostores/preact'
import { useEffect, useRef, useState } from 'react'
import tw from 'twin.macro'
import { WritableAtom } from 'nanostores'
import { Challenge67LeaderboardEditor, useKeybind } from '../components'
import {
  GIF_OPTIONS,
  GifOption,
  burstCount,
  burstIntervalSec,
  burstModeEnabled,
  camSize,
  canvasSize,
  challenge67Enabled,
  debugEnabled,
  multiTarget,
  COY_LOGOS,
  selectedCoyLogo,
  BANNER_LOGOS,
  BANNER_LOGO_ORDER,
  selectedBannerLogo,
  offlineOnly,
  cameraInitialized,
  cameraSource,
  getBackendHttpUrl,
  replayReturnSource,
  replayVideo,
  replayVideoLabel,
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
  qrScubaLocked,
  qrOcFusionLocked,
  qrSunglassesLocked,
  qrMustacheLocked,
  qrModeEnabled,
  router,
  selectedGifs,
  MAX_SELECTED,
  canSelect,
  conflictingWith,
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

function SwitchRow({
  label,
  boolVar,
  onToggle,
}: {
  label: string
  boolVar: WritableAtom
  /** fired after boolVar is set, with the new value - lets two switches
   * clear each other on click (see 67 Mode / QR Code Mode below) without
   * SwitchRow needing to know about that relationship itself. */
  onToggle?: (next: boolean) => void
}) {
  const value = useStore(boolVar)
  return (
    <div tw='flex items-center justify-between py-0.5'>
      <span tw='text-sm text-gray-300'>{label}</span>
      <button
        role='switch'
        aria-checked={value}
        tw='relative w-10 h-[22px] rounded-full transition-colors duration-200 focus:outline-none flex-shrink-0'
        css={value ? tw`bg-blue-600` : tw`bg-gray-600`}
        onClick={() => {
          const next = !value
          boolVar.set(next)
          onToggle?.(next)
        }}
      >
        <span
          tw='absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow transition-transform duration-200'
          css={value && tw`translate-x-[18px]`}
        />
      </button>
    </div>
  )
}

/** Dropdown that opens into a checkbox list — lets several logos (or, above,
 * several animations) be selected at once while still collapsing to a
 * single closed control like a normal dropdown. Selecting several grows the
 * row they're drawn in outward rather than shrinking logos to fit — see
 * anim/banner.ts and lib/photoStrip.ts's drawFooter. */
function LogoMultiSelect<K extends string>({
  label,
  helperText,
  options,
  order,
  selectedAtom,
}: {
  label: string
  helperText: string
  options: Record<K, string>
  /** Display order, when it's not safe to rely on Object.keys(options) - see
   * BANNER_LOGO_ORDER in store.ts. Defaults to Object.keys(options), which
   * is fine for options with no integer-like keys (e.g. COY_LOGOS). */
  order?: readonly K[]
  selectedAtom: WritableAtom<K[]>
}) {
  const selected = useStore(selectedAtom)
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

  const keys = order ?? (Object.keys(options) as K[])
  const entries = keys.filter((key) => key !== 'none').map((key): [K, string] => [key, options[key]])
  const summary = selected.length === 0
    ? 'No logo'
    : selected.map((k) => options[k]).join(', ')

  return (
    <div ref={rootRef} tw='relative flex flex-col gap-1'>
      <span tw='text-xs text-gray-500'>{label}</span>
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
          {entries.map(([key, optLabel]) => {
            const checked = selected.includes(key)
            return (
              <label
                key={key}
                tw='flex items-center gap-2 text-sm text-gray-300 px-2 py-1.5 rounded hover:bg-gray-700 cursor-pointer'
              >
                <input
                  type='checkbox'
                  checked={checked}
                  onChange={() =>
                    selectedAtom.set(
                      checked
                        ? selected.filter((k) => k !== key)
                        : [...selected, key],
                    )
                  }
                />
                {optLabel}
              </label>
            )
          })}
        </div>
      )}
      <span tw='text-xs text-gray-500'>{helperText}</span>
    </div>
  )
}

/** The middle slot in the photo strip footer, which is [11logo] [these, side
 * by side] [QR]. 11logo is fixed; this slot holds zero or more company logos,
 * fusionlogo by default. */
function CoyLogoSelect() {
  return (
    <LogoMultiSelect
      label='Footer Logo'
      helperText='Sits beside the 11 logo on photo strips taken from now on; strips already taken keep the logos they were made with.'
      options={COY_LOGOS}
      selectedAtom={selectedCoyLogo}
    />
  )
}

/** The logo(s) shown over the live feed, at the bottom of the banner frame.
 *
 * Separate from the footer selector: this one appears in every captured photo
 * (the frame hides during capture, the logo does not), while the footer one
 * appears on the printed strip. They can differ. */
function BannerLogoSelect() {
  return (
    <LogoMultiSelect
      label='Banner Logo'
      helperText='Shown on the live feed and included in every photo taken.'
      options={BANNER_LOGOS}
      order={BANNER_LOGO_ORDER}
      selectedAtom={selectedBannerLogo}
    />
  )
}

/** Plays a recorded video in place of the camera, for testing animations
 * against the same footage repeatedly.
 *
 * A browser file picker only exposes the file's contents, never its path, so
 * the video is uploaded to the backend once and played from there. Choosing
 * the same file again skips the upload. */
function ReplayVideoSelect() {
  const source = useStore(cameraSource)
  const label = useStore(replayVideoLabel)
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const replaying = source === 'replay'

  const startReplay = (name: string, filename: string) => {
    if (cameraSource.get() !== 'replay') replayReturnSource.set(cameraSource.get())
    replayVideo.set(name)
    replayVideoLabel.set(filename)
    cameraSource.set('replay')
  }

  const upload = (file: File, name: string) =>
    new Promise<void>((resolve, reject) => {
      // XMLHttpRequest rather than fetch: fetch reports no upload progress,
      // and a recording can take a while to send from another device.
      const xhr = new XMLHttpRequest()
      const q = `name=${encodeURIComponent(file.name)}&size=${file.size}`
      xhr.open('POST', `${getBackendHttpUrl()}/replay/upload?${q}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setStatus(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`)
        }
      }
      xhr.onload = () =>
        xhr.status === 200
          ? resolve()
          : reject(new Error(xhr.responseText || `HTTP ${xhr.status}`))
      xhr.onerror = () => reject(new Error('Could not reach the backend'))
      xhr.send(file)
    }).then(() => startReplay(name, file.name))

  const onPick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setStatus('Checking…')
    try {
      const q = `name=${encodeURIComponent(file.name)}&size=${file.size}`
      const res = await fetch(`${getBackendHttpUrl()}/replay/check?${q}`)
      if (!res.ok) throw new Error(await res.text())
      const { name, exists } = (await res.json()) as { name: string; exists: boolean }
      if (exists) startReplay(name, file.name)
      else await upload(file, name)
      setStatus('')
    } catch (e) {
      setStatus(`Failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
      // Cleared so picking the same file again still fires onChange.
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div tw='flex flex-col gap-1'>
      <span tw='text-xs text-gray-500'>Test Video</span>
      <input
        ref={inputRef}
        type='file'
        accept='video/*,.mkv,.ts'
        tw='hidden'
        onChange={(e) => onPick((e.target as HTMLInputElement).files?.[0])}
      />
      <button
        type='button'
        disabled={busy}
        tw='w-full text-sm py-2 px-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-left transition-colors disabled:opacity-50'
        onClick={() => inputRef.current?.click()}
      >
        {busy ? status : replaying ? 'Choose another video…' : 'Choose video…'}
      </button>
      {replaying && (
        <>
          <span tw='text-xs text-gray-400 truncate' title={label}>
            Replaying {label || 'video'} on a loop
          </span>
          <button
            type='button'
            tw='w-full text-sm py-2 px-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-left transition-colors'
            onClick={() => cameraSource.set(replayReturnSource.get())}
          >
            Stop replay (back to camera)
          </button>
        </>
      )}
      {!busy && status && <span tw='text-xs text-red-400'>{status}</span>}
      <span tw='text-xs text-gray-500'>
        Plays a recording through detection as if it were the camera.
      </span>
    </div>
  )
}

type ClipAnalysis = {
  fps: number
  framesAnalyzed: number
  framesTotal: number
  detectionRate: number
  handDetectionRate: number
  meanKeypointConf: number | null
  minKeypointConf: number | null
  maxPeopleSeen: number
  series: { t: number; people: number; meanConf: number | null; hands: number }[]
}

function ClipAnalysisChart({ series, maxPeople }: {
  series: ClipAnalysis['series']
  maxPeople: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || series.length === 0) return
    const w = canvas.width, h = canvas.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    const plot = (values: (number | null)[], scale: number, color: string) => {
      ctx.beginPath()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      let started = false
      values.forEach((v, i) => {
        if (v === null) return
        const x = (i / (values.length - 1 || 1)) * w
        const y = h - (v / scale) * h
        if (!started) { ctx.moveTo(x, y); started = true }
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }

    // Confidence (0-1) in blue, person count (0-maxPeople) in orange - both
    // sharing the same 0-1 vertical space so a drop in either is visible at
    // a glance without needing two separate axes.
    plot(series.map((r) => r.meanConf), 1, '#3b82f6')
    plot(series.map((r) => r.people), Math.max(1, maxPeople), '#f59e0b')
  }, [series, maxPeople])

  return (
    <div tw='flex flex-col gap-1'>
      <canvas ref={canvasRef} width={280} height={60} tw='w-full h-[60px] bg-gray-900 rounded' />
      <div tw='flex gap-4 text-[10px] text-gray-500'>
        <span><span tw='text-blue-500'>■</span> keypoint confidence</span>
        <span><span tw='text-yellow-500'>■</span> people detected (of {maxPeople})</span>
      </div>
    </div>
  )
}

function ClipAnalyzer() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ClipAnalysis | null>(null)

  const analyze = (file: File) =>
    new Promise<ClipAnalysis>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const q = `name=${encodeURIComponent(file.name)}`
      xhr.open('POST', `${getBackendHttpUrl()}/testing/analyze?${q}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setStatus(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`)
        }
      }
      xhr.upload.onload = () => setStatus('Analyzing… this can take a bit')
      xhr.onload = () => {
        if (xhr.status !== 200) {
          reject(new Error(xhr.responseText || `HTTP ${xhr.status}`))
          return
        }
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Backend returned an unreadable response'))
        }
      }
      xhr.onerror = () => reject(new Error('Could not reach the backend'))
      xhr.send(file)
    })

  const onPick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setResult(null)
    setStatus('Uploading…')
    try {
      setResult(await analyze(file))
      setStatus('')
    } catch (e) {
      setStatus(`Failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div tw='flex flex-col gap-1'>
      <span tw='text-xs text-gray-500'>Detection Accuracy</span>
      <input
        ref={inputRef}
        type='file'
        accept='video/*,.mkv,.ts'
        tw='hidden'
        onChange={(e) => onPick((e.target as HTMLInputElement).files?.[0])}
      />
      <button
        type='button'
        disabled={busy}
        tw='w-full text-sm py-2 px-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-left transition-colors disabled:opacity-50'
        onClick={() => inputRef.current?.click()}
      >
        {busy ? status : 'Analyze clip…'}
      </button>
      {!busy && status && <span tw='text-xs text-red-400'>{status}</span>}
      {result && (
        <div tw='flex flex-col gap-2 mt-1 p-2 bg-gray-800 rounded-lg'>
          <ClipAnalysisChart series={result.series} maxPeople={result.maxPeopleSeen} />
          <div tw='grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-300'>
            <span>Frames analyzed</span>
            <span tw='text-right'>{result.framesAnalyzed} / {result.framesTotal}</span>
            <span>Detection rate</span>
            <span tw='text-right'>{Math.round(result.detectionRate * 100)}%</span>
            <span>Hand detection rate</span>
            <span tw='text-right'>{Math.round(result.handDetectionRate * 100)}%</span>
            <span>Mean keypoint conf.</span>
            <span tw='text-right'>{result.meanKeypointConf ?? '—'}</span>
            <span>Min keypoint conf.</span>
            <span tw='text-right'>{result.minKeypointConf ?? '—'}</span>
            <span>Max people seen</span>
            <span tw='text-right'>{result.maxPeopleSeen}</span>
          </div>
        </div>
      )}
      <span tw='text-xs text-gray-500'>
        Runs a short clip through pose + hand detection and reports how
        confidently it tracked people over the clip - useful for measuring
        how accuracy holds up at distance or with multiple people in frame.
        Briefly pauses live pose tracking while it runs.
      </span>
    </div>
  )
}

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
            const blocked = !canSelect(gifOptions, option)
            const clash = conflictingWith(gifOptions, option)
            return (
              <label
                key={key}
                tw='flex items-center gap-2 text-sm text-gray-300 px-2 py-1.5 rounded hover:bg-gray-700 cursor-pointer'
              >
                <input
                  type='checkbox'
                  checked={checked}
                  // This dropdown previously enforced neither the count limit
                  // nor exclusivity, so it could produce selections the
                  // thumbnail pickers refuse to make. Same shared rule now.
                  disabled={blocked}
                  onChange={() =>
                    selectedGifs.set(
                      checked
                        ? gifOptions.filter((o) => o !== option)
                        : [...gifOptions, option],
                    )
                  }
                />
                {label}
                {blocked && (
                  <span tw='text-xs text-gray-500'>
                    {clash
                      ? `— not with ${GIF_OPTIONS[clash]}`
                      : `— limit of ${MAX_SELECTED}`}
                  </span>
                )}
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
      {/* String() on defaultValue below: Preact types it as string-only where
          React allows numbers, and value.width/height are numbers. The DOM
          coerces either way, so this is what was already happening
          implicitly - the values are read back out with parseInt anyway. */}
      <div tw='flex items-center gap-2'>
        <input
          ref={widthRef}
          tw='w-16 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded text-center focus:outline-none focus:border-blue-500'
          type='number'
          min={0}
          max={3840}
          defaultValue={String(value.width)}
        />
        <span tw='text-gray-500 text-sm'>×</span>
        <input
          ref={heightRef}
          tw='w-16 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded text-center focus:outline-none focus:border-blue-500'
          type='number'
          min={0}
          max={2160}
          defaultValue={String(value.height)}
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
  const challenge67 = useStore(challenge67Enabled)

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
            {!qrMode && !challenge67 && <AnimMultiSelect />}
            {!qrMode && !challenge67 && (
              <SwitchRow label='Multi-Person Tracking' boolVar={multiTarget} />
            )}
            {/* Neither applies in 67 Mode: it replaces the whole capture
                flow, so there's no live-feed banner or photo strip for
                either logo to appear on - see the matching skip in
                Display.tsx's createBanner call. */}
            {!challenge67 && <BannerLogoSelect />}
            {!challenge67 && <CoyLogoSelect />}
            <SwitchRow label='Arrow Pointer' boolVar={pointerEnabled} />
            <SwitchRow label='Debug Animation' boolVar={debugEnabled} />
            {!challenge67 && (
              <SwitchRow
                label='QR Code Mode'
                boolVar={qrModeEnabled}
                onToggle={(next) => {
                  if (next) challenge67Enabled.set(false)
                }}
              />
            )}
            {!qrMode && (
              <SwitchRow
                label='Enable 67 Mode'
                boolVar={challenge67Enabled}
                onToggle={(next) => {
                  if (next) qrModeEnabled.set(false)
                }}
              />
            )}
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
                  qrScubaLocked.set(false)
                  qrOcFusionLocked.set(false)
                  qrSunglassesLocked.set(false)
                  qrMustacheLocked.set(false)
                }}
              >
                Reset Animation
              </button>
            )}
          </Section>

          {/* Always shown, not just while 67 Mode is enabled - pruning old
              scores between events is a separate concern from whether the
              game is currently switched on. */}
          <Section title='67 Mode'>
            <Challenge67LeaderboardEditor />
          </Section>

          <Section title='Testing'>
            <ReplayVideoSelect />
            <ClipAnalyzer />
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
