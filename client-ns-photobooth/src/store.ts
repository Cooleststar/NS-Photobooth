import { persistentAtom } from '@nanostores/persistent'
import { createRouter } from '@nanostores/router'
import { atom, map } from 'nanostores'
import { savePictures } from './lib/picturesDb'
import * as PIXI from './pixi'
import pulauTekongBg from './assets/pulautekongbackground/pulau_tekong.jpg'

const opts = {
  encode: JSON.stringify,
  decode: JSON.parse,
}

// TODO: some sort of visual display to warn about certain settings like offineOnly?
// url should be in debug view

// NOTE: a global app store like this goes against componentization principles
// aka its only acceptable for top-level components like pages or settings

export const debugEnabled = persistentAtom('debugEnabled', false, opts)
export const owlEnabled = persistentAtom('owlEnabled', true, opts)
export const bannerEnabled = persistentAtom('bannerEnabled', true, opts)

export const GIF_OPTIONS = {
  none: 'No animation',
  owl: 'Owl',
  bat: 'Bat',
  globe: 'Globe',
  laptop: 'Laptop',
  drone: 'Drone',
  scuba: 'Scuba',
  ocfusion: 'OC Fusion',
  pignose: 'Pig Nose & Ears',
  batears: 'Bat Ears',
  clownwignose: 'Clown Wig & Nose',
  sunglasses: 'Sunglasses',
  mustache: 'Mustache',
} as const
export type GifOption = keyof typeof GIF_OPTIONS
/** Every currently-active pose/hand-tracked animation and/or corner-prop —
 * multiple can be on at once, all stacked on the same tracked person.
 * 'none' is never a member: an empty array means "no animation" instead. */
export const selectedGifs = persistentAtom<GifOption[]>('selectedGifs', ['owl'], opts)
// Self-heal once at load: a character removed from GIF_OPTIONS (e.g. Pig)
// can still be sitting in an existing browser's persisted selection from
// before the removal — silently dropping it here (rather than leaving it to
// blow up wherever selectedGifs gets consumed) is what actually clears a
// stuck "always loading" state for existing sessions, not just future ones.
{
  const validOptions = new Set<string>(Object.keys(GIF_OPTIONS))
  const current = selectedGifs.get()
  const cleaned = current.filter((g) => validOptions.has(g))
  if (cleaned.length !== current.length) selectedGifs.set(cleaned)
}
export const pointerEnabled = atom(false)
export const multiTarget = persistentAtom('multiTarget', false, opts)

// Discord-style virtual background: segments the guest out of the live feed
// (see anim/virtualBackground.ts) and composites them over a chosen still
// image instead of their real surroundings. Keyed object (not an array) so
// adding a new background later is just one new entry + one new asset
// import, same pattern as GIF_OPTIONS above.
export const BACKGROUND_OPTIONS = {
  pulau_tekong: { label: 'Pulau Tekong', url: pulauTekongBg },
} as const
export type BackgroundOption = keyof typeof BACKGROUND_OPTIONS
export const virtualBackgroundEnabled = persistentAtom('virtualBackgroundEnabled', false, opts)
export const selectedBackground = persistentAtom<BackgroundOption>(
  'selectedBackground',
  Object.keys(BACKGROUND_OPTIONS)[0] as BackgroundOption,
  opts,
)
// When on, the backend switches from pose/hand tracking to QR-code
// detection: a guest holding the drone QR code up to the camera triggers
// the drone gif — see QR_DRONE_PAYLOAD in Display.tsx for the mapped text.
export const qrModeEnabled = persistentAtom('qrModeEnabled', false, opts)
// True once the QR-triggered drone has locked onto a guest's face — from
// then on it follows their head position instead of staying at a fixed
// spot, and keeps following even after the QR code is put away or a photo
// is taken. Not persisted: intentionally resets on reload (a fresh booth
// session shouldn't stay locked onto yesterday's guest), and otherwise only
// clears via the "Reset Drone Lock" button in Settings.
export const qrDroneLocked = atom(false)
// One of these per QR-triggerable character (see the matching QR_*_PAYLOAD
// constants in Display.tsx) — true once that character has locked onto a
// guest via their own QR code. Same "locked forever" philosophy as
// qrDroneLocked: once acquired, a lock never releases itself, even if the
// character's own visual fades out (e.g. a brief tracking hiccup) — only
// the "Reset Animation" button in Settings hands it back to a new guest.
// Not persisted: intentionally resets on reload.
export const qrOwlLocked = atom(false)
export const qrBatLocked = atom(false)
export const qrGlobeLocked = atom(false)
export const qrClownLocked = atom(false)
export const qrPigNoseLocked = atom(false)
export const qrBatEarsLocked = atom(false)
// QR-only, like the drone — ORDLO isn't a normal AnimPicker character
// (see anim/ordlo.ts), so unlike the atoms above there's no matching
// GifOption/CHARACTER_OPTIONS entry for it.
export const qrOrdloLocked = atom(false)

// new backend requires video be sent to backend rather than the other way around
export const selectedDevice = atom<string | undefined>(undefined)

export const HIKVISION_IPS = ['65', '66', '67', '68', '69', '70'] as const
export type HikvisionIP = typeof HIKVISION_IPS[number]
export const RTSP_BASE = 'rtsp://admin:CV@hikvision@192.168.1.'
export const HIKVISION_USER = 'admin'
export const HIKVISION_PASS = 'CV@hikvision'
export type CameraSource = HikvisionIP | 'custom' | 'webcam'
export const cameraSource = persistentAtom<CameraSource>('cameraSource', '65', opts)
export const customRtspURL = persistentAtom<string>('customRtspURL', '')


export const offlineOnly = persistentAtom('offlineOnly', true, opts)
export const cameraInitialized = persistentAtom('cameraInitialized', false, opts)

export const canvasSize = persistentAtom(
  'canvasSize',
  {
    height: 1080,
    width: 1920,
  },
  opts,
)

export const camSize = persistentAtom(
  'cameraSize',
  {
    height: 1080,
    width: 1920,
  },
  opts,
)

// Resolution requested for the SEPARATE camera stream sent to the backend
// for pose/hand/QR detection (see useNiceRTC in Display.tsx) — independent
// of camSize, which is what the local canvas (and therefore captured
// photos) actually renders at. Keeping this lower lets camSize be raised
// for photo quality (e.g. 2560x1440) without doubling the camera bandwidth/
// encode load that a second full-res stream would add, which is what was
// causing the live feed to buffer.
export const detectionCamSize = persistentAtom(
  'detectionCameraSize',
  {
    height: 720,
    width: 1280,
  },
  opts,
)

export const enableRTC = atom(false)

export const nicepipeURL = persistentAtom<string>(
  'nicepipeURL',
  'ws://localhost:9091',
)

export function getBackendHttpUrl(): string {
  return `http://${window.location.hostname}:8081`
}

export const burstModeEnabled = persistentAtom('burstModeEnabled', false, opts)
export const burstCount = persistentAtom('burstCount', 3, opts)
export const burstIntervalSec = persistentAtom<number>('burstIntervalSec', 1, opts)
// Delay before the first shot of a capture — applies to both single shots
// and the initial shot of a burst. Was a fixed VITE_PHOTO_COUNTDOWN env var.
export const photoCountdownSec = persistentAtom<number>(
  'photoCountdownSec',
  parseInt(import.meta.env.VITE_PHOTO_COUNTDOWN) || 3,
  opts,
)

export interface Picture {
  timestamp: number
  data: string
  url: string
  /** burst-mode photo strip — already has its own QR code baked into the image */
  isStrip?: boolean
  /** raw (un-composited) photos that make up the strip, so it can be
   * regenerated in a different background color */
  stripPhotos?: string[]
  /** current strip background color, so recoloring knows what to regenerate from */
  bgColor?: string
}

// Backed by IndexedDB (see lib/picturesDb.ts) instead of persistentAtom's
// localStorage, since base64 photo data quickly exceeds localStorage's quota
// and would otherwise silently fail to persist across app restarts.
export const pictures = atom<Picture[]>([])
pictures.listen((pics) => {
  savePictures(pics)
})
export function addPicture(pic: Picture) {
  pictures.set(
    [...pictures.get(), pic].sort((a, b) => a.timestamp - b.timestamp),
  )
}
export const router = createRouter({
  select: '/',
  booth: '/booth',
})

export const textureCache = map<Record<string, PIXI.LoaderResource>>({})

/** current pose = this % number of poses */
export const poseInd = atom<number>(0)

export const freezePosition = atom<boolean>(false)
