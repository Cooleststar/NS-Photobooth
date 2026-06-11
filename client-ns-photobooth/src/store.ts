import { persistentAtom } from '@nanostores/persistent'
import { createRouter } from '@nanostores/router'
import { atom, map } from 'nanostores'
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
  globe: 'Globe',
  parrot: 'Parrot',
  laptop: 'Laptop',
  v15: 'V15 Drone',
} as const
export type GifOption = keyof typeof GIF_OPTIONS
export const selectedGif = persistentAtom<GifOption>('selectedGif', 'owl', opts)
export const pointerEnabled = atom(true)

// new backend requires video be sent to backend rather than the other way around
export const selectedDevice = atom<string | undefined>(undefined)

export const offlineOnly = persistentAtom('offlineOnly', true, opts)

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
  'ws://localhost:9090',
)

export interface Picture {
  timestamp: number
  data: string
  url: string
}

export const pictures = persistentAtom<Picture[]>('picturesTaken', [], opts)
export function addPicture(pic: Picture) {
  pictures.set(
    [...pictures.get(), pic].sort((a, b) => a.timestamp - b.timestamp),
  )
}

export const router = createRouter({
  home: '/',
  qr: '/qr',
})

export const textureCache = map<Record<string, PIXI.LoaderResource>>({})

/** current pose = this % number of poses */
export const poseInd = atom<number>(0)

export const freezePosition = atom<boolean>(false)
