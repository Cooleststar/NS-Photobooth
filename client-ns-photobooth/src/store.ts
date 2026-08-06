import { persistentAtom } from '@nanostores/persistent'
import { createRouter } from '@nanostores/router'
import { atom, map } from 'nanostores'
import { savePictures } from './lib/picturesDb'
import * as PIXI from './pixi'

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
  owl: 'Owl',
  bat: 'Bat',
  globe: 'Globe',
  laptop: 'Laptop',
  drone: 'Drone',
  scuba: 'Scuba',
} as const
export type GifOption = keyof typeof GIF_OPTIONS
export const selectedGif = persistentAtom<GifOption>('selectedGif', 'owl', opts)
export const pointerEnabled = atom(true)
export const multiTarget = persistentAtom('multiTarget', false, opts)

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
export const saveDirHandle = atom<FileSystemDirectoryHandle | null>(null)
export const saveDirName = persistentAtom<string>('saveDirName', '')

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
export function updatePicture(timestamp: number, patch: Partial<Picture>) {
  pictures.set(
    pictures.get().map((p) => (p.timestamp === timestamp ? { ...p, ...patch } : p)),
  )
}
export function deletePicture(timestamp: number) {
  pictures.set(pictures.get().filter((p) => p.timestamp !== timestamp))
}

export const router = createRouter({
  select: '/',
  booth: '/booth',
  qr: '/qr',
})

export const textureCache = map<Record<string, PIXI.LoaderResource>>({})

/** current pose = this % number of poses */
export const poseInd = atom<number>(0)

export const freezePosition = atom<boolean>(false)
