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

export const GIF_OPTIONS = {
  none: 'No animation',
  owl: 'Owl',
  bat: 'Bat',
  globe: 'Globe',
  drone: 'Drone',
  scuba: 'Scuba',
  ocfusion: 'OC Fusion',
  pignose: 'Pig Nose & Ears',
  batears: 'Bat Ears',
  clownwignose: 'Clown Wig & Nose',
  sunglasses: 'Sunglasses',
  mustache: 'Mustache',
  sixseven: '67',
  boxglove: 'Boxing Gloves',
} as const
export type GifOption = keyof typeof GIF_OPTIONS
/** Every currently-active pose/hand-tracked animation and/or corner-prop —
 * multiple can be on at once, all stacked on the same tracked person.
 * 'none' is never a member: an empty array means "no animation" instead. */
export const selectedGifs = persistentAtom<GifOption[]>('selectedGifs', ['owl'], opts)

// ---------------------------------------------------------------------------
// Per-character size
// ---------------------------------------------------------------------------
// A multiplier on each character's own size, 1 meaning the size it was tuned
// at. Set from Settings (pick a character, then drag), and read live every
// frame, so a booth standing further back than usual can be trimmed on the
// spot without a rebuild or a code change.
//
// Per character rather than one global scale because the characters do not
// share a sizing basis. Most already measure themselves against the person -
// ear separation (sunglasses, mustache, pig nose, bat ears, clown), shoulder
// width (globe, scuba, bat), the hand box (gloves) or head width (the dizzy
// stars) - and so already hold up at any distance. Owl, drone and sixseven
// instead take a fixed slice of the SCREEN, which is why those are the ones
// that read too large once people stand further away. One global knob would
// have to shrink the correct ten to fix those three.
export const ANIM_SIZE_MIN = 0.3
export const ANIM_SIZE_MAX = 2.5

/** Sparse: only characters actually adjusted are stored, everything else is
 * 1. Keeps a stale entry for a removed character harmless, and means the
 * default costs nothing. */
export const animSizes = persistentAtom<Record<string, number>>('animSizes', {}, opts)

/** This character's size multiplier, clamped. Called per frame from the
 * animations, so it stays cheap and never throws on a hand-edited value. */
export function getAnimScale(option: GifOption): number {
  const v = animSizes.get()[option]
  if (typeof v !== 'number' || !isFinite(v)) return 1
  return Math.min(ANIM_SIZE_MAX, Math.max(ANIM_SIZE_MIN, v))
}

export function setAnimScale(option: GifOption, value: number) {
  animSizes.set({ ...animSizes.get(), [option]: value })
}

/** Back to the tuned default by dropping the entry, not by writing 1 - so a
 * character that is later re-tuned in code picks the new value up. */
export function resetAnimScale(option: GifOption) {
  const next = { ...animSizes.get() }
  delete next[option]
  animSizes.set(next)
}
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
/** How many characters can be selected at once. Lives here rather than in a
 * picker because three separate components write selectedGifs (AnimPicker,
 * OcFusionPicker, the Settings dropdown) and a per-component copy drifts —
 * this constant was already duplicated across two of them, and Settings
 * enforced no limit at all. */
export const MAX_SELECTED = 5

/** Sets of characters that cannot be active together.
 *
 * owl + bat: both perch on the forearm, between elbow and wrist, on the same
 * tracked arm — see calculateArmFromPose in api/nicepipe/mpPose. Selecting
 * both puts two creatures in one spot, overlapping and fighting for the same
 * few pixels rather than reading as two characters.
 *
 * drone + sixseven: both trigger on the same palm-to-the-sky gesture, so
 * selecting both spawns a drone and a number on every one of the same palms,
 * overlapping rather than reading as two props.
 *
 * scuba + boxglove: scuba triggers on continuously waving a wrist side to
 * side (see its gesture section), and nothing about waving requires an open
 * hand — so a wave done with a curled hand puts a glove on the very hand
 * doing the waving, and both props fire at once. Observed in live use.
 *
 * Note the difference between that pairing and the two NOT listed below: the
 * scuba clash is structural, since the glove lands on the same hand the
 * gesture is made with every time, while 67 and the drone only clash when a
 * particular ambiguous hand pose happens to coincide.
 *
 * boxglove + sixseven and boxglove + drone are deliberately absent. These
 * characters are for a group, where different people are doing different
 * things, and in practice the open-palm and closed-fist poses hardly ever
 * land on one hand. Measured over 48 frames of the 5-person test footage,
 * counting hands that would actually carry each prop:
 *
 *     67 numbers     0 of 214  (0.0%)  also qualified for a glove
 *     drones        14 of 371  (3.8%)  also qualified for a glove
 *
 * 67 is exactly zero because it only ever draws on a PAIR of palm-up hands
 * from one person forming a diagonal, and a lone curled palm-up hand never
 * forms one. The drone needs just one palm, so its ambiguous hands are not
 * ruled out the same way — hence the small but real 3.8%, where a drone
 * perches on a gloved fist. Judged acceptable against the group use case.
 *
 * (A blanket "ignore curled hands" filter was tried on 67 and removed as
 * unnecessary — it cost real palms to prevent a case that never occurred.
 * If the drone overlap ever does become annoying in use, that filter is the
 * lever, applied to drone.ts rather than to this list.)
 *
 * Add further groups here; nothing else needs changing. */
export const EXCLUSIVE_GROUPS: readonly (readonly GifOption[])[] = [
  ['owl', 'bat'],
  ['drone', 'sixseven'],
  ['scuba', 'boxglove'],
]

/** Which already-selected option, if any, blocks `option` from being added.
 * Returns undefined when the selection is allowed. Callers use this both to
 * disable the control and to explain why in its tooltip — a disabled button
 * with no reason reads as broken. */
export function conflictingWith(
  current: readonly GifOption[],
  option: GifOption,
): GifOption | undefined {
  for (const group of EXCLUSIVE_GROUPS) {
    if (!group.includes(option)) continue
    const clash = group.find((o) => o !== option && current.includes(o))
    if (clash) return clash
  }
  return undefined
}

/** Whether `option` can be added to `current`: under the count limit and not
 * conflicting. Already-selected options always pass, so deselecting is never
 * blocked. */
export function canSelect(
  current: readonly GifOption[],
  option: GifOption,
): boolean {
  if (current.includes(option)) return true
  if (current.length >= MAX_SELECTED) return false
  return conflictingWith(current, option) === undefined
}

// Self-heal, same reasoning as the GIF_OPTIONS cleanup above: a browser can
// hold a persisted selection made before a rule existed — owl and bat both on,
// from before they became mutually exclusive. Drop the later member rather
// than leaving an impossible state that the UI can express but not produce.
{
  const current = selectedGifs.get()
  const kept: GifOption[] = []
  for (const option of current) {
    if (conflictingWith(kept, option) === undefined) kept.push(option)
  }
  if (kept.length !== current.length) selectedGifs.set(kept)
}

/** What occupies the middle logo slot in the photo strip footer.
 *
 * The footer is [11logo] [these, side by side] [QR]. 11logo is fixed and
 * always drawn; the middle slot holds zero or more company logos, and the
 * block they form grows outward (each logo keeps its own footprint; the
 * block widens as more are picked) rather than shrinking logos to fit a
 * fixed width - see drawFooter in lib/photoStrip.ts.
 *
 * The files live in assets/icons and are imported by lib/photoStrip.ts - only
 * the key is stored here, so a selection persisted in a browser stays valid if
 * an image is renamed or re-exported.
 *
 * ['fusion'] is the default because that is what the slot held (as a single,
 * fixed logo) before this became selectable, so an existing booth looks
 * unchanged on upgrade. 'none' is a clear-all, like GifOption's 'none' above
 * - it is never itself a member of the selected array, an empty array is. */
export const COY_LOGOS = {
  fusion: 'Fusion (default)',
  none: 'No logo',
  atlas: 'Atlas',
  boreas: 'Boreas',
  hq: 'HQ',
  rsta: 'RSTA',
  signal: 'Signal',
} as const
export type CoyLogo = keyof typeof COY_LOGOS

export const selectedCoyLogo = persistentAtom<CoyLogo[]>('coyLogo', ['fusion'], opts)

/** The logo(s) shown over the live feed, side by side, growing outward from
 * the same centre point the single logo used to occupy - see createBanner in
 * anim/banner.ts.
 *
 * It used to be painted into border_design6.png itself, which is why it could
 * not be changed and never reached a captured photo - a decorative frame
 * drawn around the feed was hidden during capture, and the logo was baked
 * into that same image. The logo was later split into its own sprite that
 * stayed visible while the frame hid, so it appeared in photos; the frame
 * itself was subsequently removed entirely (anim/banner.ts) as a redundant
 * toggle once the logo already had its own on/off control, leaving just the
 * logo(s) described here.
 *
 * ['11'] is the default because that is the logo that was baked in, so a
 * booth looks unchanged on upgrade. '11' is offered here and not in the
 * footer because the footer already draws 11logo in its fixed slot. */
export const BANNER_LOGOS = {
  '11': '11 (default)',
  none: 'No logo',
  fusion: 'Fusion',
  atlas: 'Atlas',
  boreas: 'Boreas',
  hq: 'HQ',
  rsta: 'RSTA',
  signal: 'Signal',
} as const
export type BannerLogo = keyof typeof BANNER_LOGOS

// Display/row order for BANNER_LOGOS - NOT the same as Object.keys(BANNER_LOGOS),
// deliberately: '11' is a key that looks like an array index ("11"), and
// JavaScript always iterates those ahead of every other string key in
// ascending numeric order, no matter where they sit in the object literal -
// so reordering the object itself cannot move '11' out of first place. This
// array is what anim/banner.ts's row, and the checkbox lists in
// Settings.tsx/TopControls.tsx, actually iterate. 'none' is excluded - same
// clear-all reasoning as GifOption's 'none'. Currently: '11' sits 4th,
// swapped with 'boreas', on request - purely a display-order preference,
// nothing about either logo specifically.
export const BANNER_LOGO_ORDER: readonly BannerLogo[] = [
  'boreas', 'fusion', 'atlas', '11', 'hq', 'rsta', 'signal',
]

export const selectedBannerLogo = persistentAtom<BannerLogo[]>('bannerLogo', ['11'], opts)

// Self-heal, same as the GIF_OPTIONS cleanup above: a key that no longer
// exists would otherwise sit in a browser's storage and resolve to an
// undefined image URL, failing at draw time rather than at selection time.
// This also catches the earlier '11' key, from when 11logo was the thing being
// replaced rather than the fixed one. 'none' is filtered out too, same as
// selectedGifs never holding 'none' - an empty array already says that.
//
// These two used to be single values (selectedCoyLogo/selectedBannerLogo were
// a plain CoyLogo/BannerLogo, not an array) before multi-select - so a
// browser that picked a logo before that change still has a bare string like
// "fusion" sitting in localStorage. persistentAtom's decode is just
// JSON.parse, which happily turns that into the STRING "fusion" rather than
// an array, and .get() below decodes lazily on first access - meaning that
// string reaches here, at module load, before anything has rendered. Calling
// .filter on it would throw synchronously and take the whole app down to a
// blank page on every load thereafter (see git history for the incident this
// guarded against). Array.isArray is the whole fix: anything else legacy
// shaped is treated as empty rather than trusted.
{
  const cleanLogos = <T extends string>(all: Record<string, string>, current: T[]): T[] => {
    if (!Array.isArray(current)) return []
    const seen = new Set<T>()
    return current.filter((k) => k !== 'none' && k in all && !seen.has(k) && seen.add(k))
  }
  const coy = selectedCoyLogo.get()
  const cleanedCoy = cleanLogos(COY_LOGOS, coy)
  if (cleanedCoy.length !== (Array.isArray(coy) ? coy.length : -1)) selectedCoyLogo.set(cleanedCoy)
  const banner = selectedBannerLogo.get()
  const cleanedBanner = cleanLogos(BANNER_LOGOS, banner)
  if (cleanedBanner.length !== (Array.isArray(banner) ? banner.length : -1)) selectedBannerLogo.set(cleanedBanner)
}

export const pointerEnabled = atom(false)
export const multiTarget = persistentAtom('multiTarget', false, opts)

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
export const qrScubaLocked = atom(false)
export const qrOcFusionLocked = atom(false)
export const qrSunglassesLocked = atom(false)
export const qrMustacheLocked = atom(false)
// QR-only, like the drone — ORDLO isn't a normal AnimPicker character
// (see anim/ordlo.ts), so unlike the atoms above there's no matching
// GifOption/CHARACTER_OPTIONS entry for it.
export const qrOrdloLocked = atom(false)

// When on, replaces the normal character picker and QR mode entirely with
// a single-player "wave your arms as fast as possible for 20s" mini-game
// (see pages/Challenge67UI.tsx) - mutually exclusive with qrModeEnabled,
// enforced in Settings.tsx (each switch clears the other on click).
export const challenge67Enabled = persistentAtom('challenge67Enabled', false, opts)

export interface Challenge67LeaderboardEntry {
  score: number
  ts: number
  name: string
}

export interface Challenge67State {
  // 'naming' sits between 'waiting'/'finished' and 'countdown' - entered on
  // pressing Start/Play Again, left once a name is confirmed. Purely a UI
  // wait state: the ticker in Display.tsx that owns every other transition
  // doesn't need to know about it, since nothing time-based happens here.
  phase: 'waiting' | 'naming' | 'countdown' | 'playing' | 'finished'
  timeLeft: number
  reps: number
  // Set once, when 'naming' -> 'countdown', and read back by
  // submitChallenge67Score in Display.tsx when the round ends - carried on
  // this shared atom rather than local state so the submit call (which
  // lives in Display.tsx, not Challenge67UI.tsx) can reach it.
  playerName: string
  lastResult?: {
    // What this round actually scored - not necessarily what's on the
    // board, since the backend only raises a name's entry when a round beats
    // it (see main.py's challenge67_submit_handler).
    score: number
    // This name's best score on the board, i.e. `score` if isNewBest,
    // otherwise whatever they'd already set in an earlier round.
    best: number
    isNewBest: boolean
    rank: number
    total: number
    // Straight from the submit response (computed server-side right after
    // the write, under its lock) rather than a separate GET fired off this
    // round's own score-writing race - see Challenge67UI.tsx for why a
    // second independent fetch used to show a stale board.
    top: Challenge67LeaderboardEntry[]
  }
}
// Ephemeral, like pointerEnabled/freezePosition below - Display.tsx's ticker
// owns the timer/phase transitions/rep counting (it already has the per-
// frame pose data and a running clock) and writes progress here every
// frame; Challenge67UI just reads it and writes 'waiting' -> 'naming' ->
// 'countdown' to kick off a round. Not persisted: a reload shouldn't resume
// mid-round (playerName included - a fresh reload re-asks for a name).
export const challenge67Game = atom<Challenge67State>({
  phase: 'waiting',
  timeLeft: 0,
  reps: 0,
  playerName: '',
})

// new backend requires video be sent to backend rather than the other way around
export const selectedDevice = atom<string | undefined>(undefined)

export const HIKVISION_IPS = ['65', '66', '67', '68', '69', '70'] as const
export type HikvisionIP = typeof HIKVISION_IPS[number]
export const RTSP_BASE = 'rtsp://admin:CV@hikvision@192.168.1.'
export const HIKVISION_USER = 'admin'
export const HIKVISION_PASS = 'CV@hikvision'
export type CameraSource = HikvisionIP | 'custom' | 'webcam' | 'replay'
export const cameraSource = persistentAtom<CameraSource>('cameraSource', '65', opts)
export const customRtspURL = persistentAtom<string>('customRtspURL', '')

// Test-video replay (Settings > Testing). The backend stores the uploaded
// video and plays it through the same reader a live camera uses; replayVideo
// is its stored name there, replayVideoLabel the original filename for
// display. replayReturnSource is the camera to go back to on Stop.
export const replayVideo = persistentAtom<string>('replayVideo', '')
export const replayVideoLabel = persistentAtom<string>('replayVideoLabel', '')
export const replayReturnSource = persistentAtom<CameraSource>('replayReturnSource', '65', opts)


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
