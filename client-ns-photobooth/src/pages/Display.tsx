import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import { useStore } from '@nanostores/preact'
import { useCam, useNiceConnState, useNiceROS, useNiceRTC } from 'nice-ros-react'
import {
  ComponentProps,
  MutableRefObject,
  RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import 'twin.macro'
import { createArrowPointer } from '../anim/arrow'
import { createBatAnim } from '../anim/bat'
import { createBanner } from '../anim/banner'
import { createClownAnim } from '../anim/clown'
import { createDroneAnim } from '../anim/drone'
import { createGlobeAnim } from '../anim/globe'
import { createOCFusionAnim } from '../anim/ocfusion'
import { createOwlAnim } from '../anim/owl'
import { createPigAnim } from '../anim/pig'
import { createPigNoseAnim } from '../anim/pignose'
import { createScubaAnim } from '../anim/scuba'
import { createSimpleFadePropAnim } from '../anim/simpleFadeProp'
import { attachStream2Pixi, drawDebug } from '../anim/stream'
import { Analysis, PropDetection } from '../api/nicepipe'
import { convert2mpPose } from '../api/nicepipe/mmPose'
import { convertPoint } from '../api/nicepipe/mpPose'
import { useNiceROSAnalysis } from '../api/niceRos'
import laptopGif from '../assets/laptop_anim/laptop.gif'
import qrDroneGif from '../assets/drone_anim/drone.gif'
import * as PIXI from '../pixi'
import {
  GifOption,
  bannerEnabled,
  camSize,
  debugEnabled,
  getBackendHttpUrl,
  multiTarget,
  nicepipeURL,
  pointerEnabled,
  qrDroneLocked,
  qrModeEnabled,
  HIKVISION_IPS,
  RTSP_BASE,
  cameraSource,
  customRtspURL,
  poseInd,
  selectedDevice,
  selectedGif,
} from '../store'

// QR mode (Settings → "QR Code Mode"): a guest holds a QR code encoding
// this exact payload string up to the camera, and the drone gif fades in at
// a fixed position — see the qrMode branch in the main render effect below.
// Only one code/gif is wired up (drone) — this project doesn't need the
// reference implementation's general multi-code mapping config.
const QR_DRONE_PAYLOAD = 'BOOTH-DRONE'

const GIF_URLS: Record<Exclude<GifOption, 'owl' | 'bat' | 'globe' | 'drone' | 'scuba' | 'ocfusion' | 'clown' | 'pig' | 'pignose' | 'none'>, string> = {
  laptop: laptopGif,
}

// Which backend model(s) each character actually needs — owl/bat/globe/
// clown/pig/scuba read body pose only, drone and ocfusion read hand
// landmarks only (ignores pose entirely), laptop is a fixed-position fade
// prop that reads neither. Told to the backend via POST /detection_mode so
// it skips idle models per-frame instead of running YOLO/ViTPose/MediaPipe
// Hands unconditionally.
const DETECTION_MODE_BY_GIF: Record<GifOption, 'pose' | 'hands' | 'none' | 'both'> = {
  none: 'none',
  owl: 'pose',
  bat: 'pose',
  globe: 'pose',
  drone: 'hands',
  laptop: 'none',
  scuba: 'pose',
  ocfusion: 'hands',
  clown: 'pose',
  pig: 'pose',
  pignose: 'pose',
}

const MARGIN_X = 30 / 1920
const MARGIN_T = 30 / 1080
const MARGIN_B = 30 / 1080

/** Stable person -> slot assignment for multi-target animations.
 *
 * Poses arrive keyed by tracker id, and Object.keys() returns those keys in
 * ascending numeric order — so driving slot i from ids[i] re-shuffles every
 * slot the moment anyone enters or leaves, and a newcomer whose id sorts
 * below an existing one shifts all the slots after it. Each slot owns its
 * own Kalman filters and AnimState, so a reshuffle makes a mask slide off
 * its person and across to another, briefly stacking two masks on one face.
 *
 * Keying by tracker id instead means a person holds the same slot for as
 * long as they are tracked, whoever else comes and goes. */
function createSlotAssigner<T>(slotCount: number) {
  const slotOf = new Map<number, number>()
  const freedAt = new Array<number>(slotCount).fill(-1)
  let tick = 0

  return (allPoses: { [id: number]: T }): (T | undefined)[] => {
    tick++
    const ids = Object.keys(allPoses).map(Number)
    const present = new Set(ids)

    for (const [id, slot] of [...slotOf]) {
      if (!present.has(id)) {
        slotOf.delete(id)
        freedAt[slot] = tick
      }
    }

    const taken = new Set(slotOf.values())
    const free: number[] = []
    for (let i = 0; i < slotCount; i++) if (!taken.has(i)) free.push(i)
    // Longest-free first, so a slot isn't handed straight to a new person
    // while its filters are still settled on the previous one.
    free.sort((a, b) => freedAt[a] - freedAt[b])

    let next = 0
    for (const id of ids) {
      if (slotOf.has(id)) continue
      if (next >= free.length) break // more people than slots — extras go unrendered
      slotOf.set(id, free[next++])
    }

    const bySlot = new Array<T | undefined>(slotCount)
    for (const [id, slot] of slotOf) bySlot[slot] = allPoses[id]
    return bySlot
  }
}

function postprocessPicture(pic: HTMLCanvasElement) {
  const { width, height } = pic

  // The live view intentionally draws a black margin border around the video
  // (see the fillRect in createReceivingCtx). That border must not reach the
  // saved/uploaded photo. This used to paint the four bands white, which just
  // swapped a black frame for a white one — visible as a white border around
  // every photo in a strip. Crop them off instead, so the exported photo is
  // pure video with no frame of any colour. The live preview still keeps its
  // black margin: only this captured copy is cropped.
  const xMargin = Math.round(MARGIN_X * width)
  const yMarginT = Math.round(MARGIN_T * height)
  const yMarginB = Math.round(MARGIN_B * height)
  const cropWidth = width - xMargin * 2
  const cropHeight = height - yMarginT - yMarginB

  const tmpCanvas = document.createElement('canvas')
  tmpCanvas.width = cropWidth
  tmpCanvas.height = cropHeight

  // capture exactly what's shown live — no extra flip, so the saved
  // photo matches the on-screen (mirrored) preview
  const ctx = tmpCanvas.getContext('2d')!
  ctx.drawImage(
    pic,
    xMargin, yMarginT, cropWidth, cropHeight, // source: inside the margins
    0, 0, cropWidth, cropHeight,              // dest: flush to the edges
  )

  return tmpCanvas
}

/*** remap normalized point when the video is scaled to be smaller than the canvas */
function remapPoint(
  x: number,
  y: number,
  canvas_ratio_wh: number,
  img_ratio_wh: number,
) {
  // insane maths was performed
  const w = 1 - 2 * MARGIN_X
  x = x * w + MARGIN_X
  y = w * (y - 1) * (canvas_ratio_wh / img_ratio_wh) + (1 - MARGIN_B)
  return [x, y] as const
}

/** Where to anchor the QR-triggered drone once locked onto someone: a point
 * above their head, not on their face. Estimates head size from ear
 * separation (falling back to a fixed minimum for very distant/occluded
 * people) so the offset scales with how close they are to the camera. */
function headTopFromPose(pose: { x: number; y: number }[]): { x: number; y: number } | undefined {
  const nose = pose[0]
  if (!nose) return undefined
  const leftEar = pose[7]
  const rightEar = pose[8]
  const earWidth = leftEar && rightEar ? Math.abs(leftEar.x - rightEar.x) : 0
  const headSize = Math.max(earWidth, 80)
  return { x: nose.x, y: nose.y - headSize * 1.1 }
}

// TODO: refactor a lot of the data processing to API...
function createReceivingCtx(
  imgRef: RefObject<HTMLImageElement | HTMLVideoElement>,
  dataRef: MutableRefObject<Analysis>,
  size?: { width: number; height: number },
  bitmapRef?: { current: ImageBitmap | null },
) {
  const { width = 640, height = 480 } = size ?? {}
  const canvas = document.createElement('canvas')
  canvas.height = height
  canvas.width = width
  const ctx = canvas.getContext('2d')!

  let prevTs = 0
  let curTs = 0
  const fps_buffer: number[] = []
  const measureFPS = () => {
    curTs = performance.now() // in milliseconds
    if (prevTs !== 0) fps_buffer.push(curTs - prevTs)
    prevTs = curTs
    if (fps_buffer.length === 0) return 0
    while (fps_buffer.length > 120) fps_buffer.shift()
    const sum = fps_buffer.reduce((a, b) => a + b, 0)
    const mean = sum / fps_buffer.length
    return 1000 / mean
  }

  let poseId = 0
  let prevIndex = 0
  return [
    canvas,
    (data: Analysis, poseIndex: number) => {
      const img = imgRef.current
      if (!img) return
      const bitmap = bitmapRef?.current
      const imgWidth = bitmap
        ? bitmap.width
        : img instanceof HTMLImageElement ? img.naturalWidth : img.videoWidth
      const imgHeight = bitmap
        ? bitmap.height
        : img instanceof HTMLImageElement ? img.naturalHeight : img.videoHeight

      if (imgWidth === 0 || imgHeight === 0) return

      const fps = measureFPS()
      ctx.clearRect(0, 0, width, height)
      // The video image is only drawn into an inset rect (see xMargin/yMargin
      // below), leaving a margin border around it — filled black explicitly
      // (rather than relying on it happening to end up that color via
      // pixi.ts's clearBeforeRender + backgroundColor) so the live preview
      // always shows a solid black border regardless of renderer settings.
      // postprocessPicture() paints this back to white on the captured copy,
      // so exported/uploaded photos don't carry the border.
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)
      ctx.save()
      ctx.translate(width, 0)
      ctx.scale(-1, 1)

      // calculate positionings and stuff
      const xMargin = MARGIN_X * width
      const btmMargin = MARGIN_B * height
      const widthTarget = width - 2 * xMargin
      const heightTarget = (widthTarget / imgWidth) * imgHeight
      const yMargin = height - heightTarget - btmMargin

      ctx.drawImage(bitmap ?? img, xMargin, yMargin, widthTarget, heightTarget)
      ctx.restore()

      // recalculate pose coordinates
      const { mmpose, mp_pose } = data
      // select pose by id, falling back to a wraparound index if not found
      let mm_pose = mmpose?.[poseId]
      if (mm_pose === undefined || poseIndex !== prevIndex) {
        const ids = Object.keys(mmpose ?? {})
        poseId = parseInt(ids[poseIndex % ids.length])
        prevIndex = poseIndex
        mm_pose = mmpose?.[poseId]
      }
      const rawPose = mm_pose
        ? convert2mpPose(mm_pose)
        : mp_pose
        ? mp_pose.pose ?? []
        : []
      const pose = rawPose.map((p) => {
        const [x, y] = remapPoint(
          p.x,
          p.y,
          width / height,
          imgWidth / imgHeight,
        )
        p = { ...p, x, y }
        return p
      })
      dataRef.current.mp_pose!.pose = pose

      // remap all people's poses for multi-target animations
      const allPoses: { [id: number]: typeof pose } = {}
      for (const [id, kps] of Object.entries(mmpose ?? {})) {
        const converted = convert2mpPose(kps as any)
        allPoses[parseInt(id)] = converted.map((p) => {
          const [rx, ry] = remapPoint(p.x, p.y, width / height, imgWidth / imgHeight)
          return { ...p, x: rx, y: ry }
        })
      }
      dataRef.current.allPoses = allPoses

      // recalculate prop coordinates
      const rawProps = data.kp ?? []
      const propDets = rawProps.map((det) => {
        let [name, box] = det
        box = box.map(([x, y]) =>
          remapPoint(1 - x, y, width / height, imgWidth / imgHeight),
        ) as typeof box
        return [name, box] as PropDetection
      })
      dataRef.current.kp = propDets

      // remap QR code positions to screen space — same convention as pose
      // (no 1-x flip, unlike propDets above) since these get compared
      // against pose/wrist positions in the qrMode lock-on logic
      dataRef.current.qrCodes = (data.qrCodes ?? []).map((qr) => {
        const [x, y] = remapPoint(qr.x, qr.y, width / height, imgWidth / imgHeight)
        return { ...qr, x, y }
      })

      // For debug, prefer real 33-pt MediaPipe pose (better head) over YOLO
      const rawDebugPose = dataRef.current.mp_debug_pose
      const debugPose = rawDebugPose
        ? rawDebugPose.map((p) => {
            const [dx, dy] = remapPoint(p.x, p.y, width / height, imgWidth / imgHeight)
            return { ...p, x: dx, y: dy }
          })
        : pose
      if (debugEnabled.get()) {
        // How stale the detection data currently driving the overlay is —
        // time since the last /pose_out message, not a frame-accurate
        // round-trip (RTSP mode never sends frames to the backend at all,
        // so round-trip timing isn't meaningful there), but a mode-agnostic
        // proxy for pipeline lag that's directly useful either way.
        const delayMs = data.lastUpdateTs !== undefined ? performance.now() - data.lastUpdateTs : undefined
        drawDebug(ctx, debugPose, propDets, fps, delayMs)
      }
    },
  ] as const
}

export interface DisplayProps extends ComponentProps<'div'> {
  height: number
  width: number
  photographerRef: MutableRefObject<(() => Promise<string>) | undefined>
}

/** nice everything is in here now */
export default function Display({
  height,
  width,
  photographerRef,
  ...props
}: DisplayProps) {
  // TIL useRef better than useState for state that doesnt affect render

  /** normalized raw data from backend */
  const rawRef = useRef<Analysis>({})
  /** absolute (converted) data */
  const dataRef = useRef<Analysis>({
    mp_pose: {
      mask: undefined,
      pose: [],
    },
    kp: [],
    mmpose: { 0: [] },
  })
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const divRef = useRef<HTMLDivElement>(null)
  const [animLoading, setAnimLoading] = useState(false)

  const deviceId = useStore(selectedDevice)
  const camRes = useStore(camSize)
  const url = useStore(nicepipeURL)
  const gifOption = useStore(selectedGif)
  const qrMode = useStore(qrModeEnabled)
  const { rosState } = useNiceConnState()
  const camSource = useStore(cameraSource)
  const customUrl = useStore(customRtspURL)
  const isMulti = useStore(multiTarget)
  const rtspUrlValue = (HIKVISION_IPS as readonly string[]).includes(camSource)
    ? RTSP_BASE + camSource + '/Streaming/Channels/101'
    : camSource === 'custom' ? customUrl : ''
  const isRtspMode = !!rtspUrlValue
  const wsStreamUrl = isRtspMode
    ? `ws://${window.location.hostname}:8081/ws_stream?url=${encodeURIComponent(rtspUrlValue)}&w=${camRes.width}&h=${camRes.height}&multi=${isMulti ? '1' : '0'}`
    : ''

  // Auto-select the first available webcam if in webcam mode and none is selected
  useEffect(() => {
    if (camSource !== 'webcam') return
    if (deviceId) return
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const cam = devices.find((d) => d.kind === 'videoinput')
      if (cam) selectedDevice.set(cam.deviceId)
    })
  }, [camSource])

  // Tell the backend which model(s) the current character needs, so it can
  // skip idle ones (e.g. no YOLO/ViTPose while drone — hand-only — is active).
  //
  // Retries on failure: this effect fires as soon as Display mounts, but
  // app.py starts the backend and frontend as concurrent processes with no
  // readiness check, and backend model loading (YOLO/MediaPipe/ViTPose)
  // takes several seconds. If this page loads first, the very first call
  // here can hit a backend that isn't listening yet — without a retry, that
  // silently leaves the backend stuck running the expensive default 'both'
  // mode (full YOLO+ViTPose) until the user happens to switch characters,
  // which is exactly what caused real, measurable GPU contention and lag
  // during drone testing even though drone only ever needs MediaPipe Hands.
  //
  // Also re-sent whenever the rosbridge connection (re)connects (rosState
  // dependency below) — the backend's detection mode is in-memory only, so
  // any backend restart silently resets it to 'both' with no way for the
  // frontend to know unless it explicitly resends on every reconnect, not
  // just once on initial mount. Without this, QR mode (and any other
  // non-default mode) would silently stop working after every backend
  // restart until the user happened to toggle something that changes
  // gifOption/qrMode again.
  useEffect(() => {
    if (rosState !== 'connected') return
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const mode = qrMode ? 'qr' : (DETECTION_MODE_BY_GIF[gifOption] ?? 'both')

    const send = () => {
      fetch(`${getBackendHttpUrl()}/detection_mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
        })
        .catch((e) => {
          console.warn('Failed to set detection mode, retrying in 2s:', e)
          if (active) retryTimer = setTimeout(send, 2000)
        })
    }
    send()

    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [gifOption, qrMode, rosState])

  const setVideo = useCallback((stream: MediaStream) => {
    if (!videoRef.current) return
    videoRef.current.srcObject = stream
  }, [])

  useCam({ deviceId: isRtspMode ? undefined : deviceId, videoConstraints: camRes, videoCallback: setVideo })


  useNiceROS(url, { enabled: true })

  useNiceRTC(deviceId, {
    enabled: !!deviceId,
    mode: 'send',
    videoConstraints: camRes,
    videoCallback: setVideo,
  })

  useNiceROSAnalysis(rawRef)

  // Send video frames to backend pose detector at /video endpoint
  // Skipped in RTSP mode — backend reads the stream directly
  useEffect(() => {
    if (isRtspMode || !deviceId) return
    const video = videoRef.current
    if (!video) return

    const videoWsUrl = url.endsWith('/') ? url + 'video' : url + '/video'
    let ws: WebSocket | null = null
    let intervalId = -1
    let active = true
    let sending = false

    function connect() {
      if (!active) return
      try {
        ws = new WebSocket(videoWsUrl)
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => {
          intervalId = window.setInterval(() => {
            if (!video || video.readyState < 2 || !ws || ws.readyState !== WebSocket.OPEN || sending) return
            sending = true
            const tmp = document.createElement('canvas')
            tmp.width = 320
            tmp.height = 240
            tmp.getContext('2d')?.drawImage(video, 0, 0, 320, 240)
            tmp.toBlob(blob => {
              sending = false
              if (!blob || !ws || ws.readyState !== WebSocket.OPEN) return
              blob.arrayBuffer().then(buf => {
                if (ws?.readyState === WebSocket.OPEN) ws.send(buf)
              })
            }, 'image/jpeg', 0.7)
          }, 100)
        }
        ws.onclose = () => {
          clearInterval(intervalId)
          if (active) setTimeout(connect, 3000)
        }
        ws.onerror = () => ws?.close()
      } catch {
        if (active) setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      active = false
      clearInterval(intervalId)
      ws?.close()
    }
  }, [deviceId, isRtspMode, url])

  useEffect(() => {
    if (!videoRef.current) return
    if (deviceId) return
    videoRef.current.srcObject = null
  }, [deviceId])

  // Receive RTSP frames over WebSocket; decode each JPEG off-thread via
  // createImageBitmap so the PixiJS tick always draws from a fully-decoded bitmap.
  const rtspBitmapRef = useRef<ImageBitmap | null>(null)
  useEffect(() => {
    if (!isRtspMode || !wsStreamUrl) return

    let ws: WebSocket | null = null
    let active = true

    function connect() {
      if (!active) return
      try {
        ws = new WebSocket(wsStreamUrl)
        ws.binaryType = 'blob'

        // One decode in flight at a time — always decode the latest blob,
        // dropping frames that arrive while the previous decode runs.
        let latestBlob: Blob | null = null
        let decoding = false
        const decode = () => {
          if (!latestBlob) { decoding = false; return }
          const blob = latestBlob
          latestBlob = null
          createImageBitmap(blob).then((bm) => {
            if (!active) { bm.close(); return }
            rtspBitmapRef.current?.close()
            rtspBitmapRef.current = bm
          }).catch(() => {}).finally(decode)
        }

        ws.onmessage = (e) => {
          latestBlob = e.data as Blob
          if (!decoding) { decoding = true; decode() }
        }
        ws.onclose = () => {
          if (active) setTimeout(connect, 2000)
        }
        ws.onerror = () => ws?.close()
      } catch {
        if (active) setTimeout(connect, 2000)
      }
    }

    connect()

    return () => {
      active = false
      ws?.close()
      rtspBitmapRef.current?.close()
      rtspBitmapRef.current = null
    }
  }, [isRtspMode, wsStreamUrl])

  useEffect(() => {
    const divElm = divRef.current
    if (!divElm) return
    const activeRef = isRtspMode ? imgRef : videoRef
    if (!activeRef.current) return

    // https://pixijs.download/release/docs/PIXI.Application.html
    // sharedTicker is false to ensure any rogue update functions are cleaned up
    // sharedLoader is true to decrease loading times by caching textures in the global loader
    const app = new PIXI.Application({
      height,
      width,
      sharedTicker: false,
      sharedLoader: true,
    })

    divElm.replaceChildren()
    divElm.appendChild(app.view)

    let [canvas, update] = createReceivingCtx(activeRef, dataRef, {
      width,
      height,
    }, isRtspMode ? rtspBitmapRef : undefined)

    attachStream2Pixi(app, canvas)
    // Feed the video into the canvas immediately, independent of animation
    // asset loading below — previously this was only wired up after the
    // gif/model finished loading, so the feed stayed black on every gif
    // switch until the new animation loaded (or forever, if it errored).
    app.ticker.add(() => update(rawRef.current, poseInd.get()))

    // Masked layer for animations — clips GIFs at the video feed boundary.
    // Uses a Sprite (from the built-in white texture) as the mask shape since
    // @pixi/graphics isn't a project dependency.
    const animLayer = new PIXI.Container()
    const feedMask = new PIXI.Sprite(PIXI.Texture.WHITE)
    feedMask.position.set(MARGIN_X * width, MARGIN_T * height)
    feedMask.width = width * (1 - 2 * MARGIN_X)
    feedMask.height = height * (1 - MARGIN_T - MARGIN_B)
    feedMask.renderable = false
    app.stage.addChild(animLayer)
    animLayer.addChild(feedMask)
    animLayer.mask = feedMask

    // Corner positions within the visible camera area (inside the border margins)
    const visLeft = MARGIN_X * width
    const visRight = (1 - MARGIN_X) * width
    const visTop = MARGIN_T * height
    const visBot = (1 - MARGIN_B) * height
    const CORNER_SIZE = Math.min(width, height) * 0.14
    const pad = CORNER_SIZE * 0.6
    const CORNER_POSITIONS = [
      { x: visLeft + pad, y: visTop + pad },     // top-left
      { x: visRight - pad, y: visTop + pad },    // top-right
      { x: visLeft + pad, y: visBot - pad },     // bottom-left
      { x: visRight - pad, y: visBot - pad },    // bottom-right
    ]

    const MAX_PEOPLE = 4
    const marginOpts = { mx: MARGIN_X, mt: MARGIN_T, mb: MARGIN_B }
    // hoisted so photographerRef.current (defined outside the IIFE below)
    // can hide the decorative banner during capture — captured photos get
    // their own border treatment in the gallery instead
    let bannerContainer: PIXI.Container | undefined

    async function createAnimForGif(option: GifOption) {
      if (option === 'owl') {
        return await createOwlAnim(app)
      } else if (option === 'bat') {
        return await createBatAnim(app)
      } else if (option === 'globe') {
        return await createGlobeAnim(app, marginOpts)
      } else if (option === 'drone') {
        const [container, updateDrone] = await createDroneAnim(app, marginOpts)
        // Drone uses MediaPipe hand landmarks, not body pose — ignore pose arg
        const wrappedUpdate = (_pose: any) => updateDrone(rawRef.current.hands ?? [])
        return [container, wrappedUpdate] as const
      } else if (option === 'scuba') {
        const [container, updateScuba] = await createScubaAnim(app, marginOpts)
        // Scuba needs all tracked people's poses (to find whoever is closest
        // to the camera), not the single `pose` arg this slot system passes,
        // so read them directly.
        const wrappedUpdate = (_pose: any) => updateScuba(dataRef.current.allPoses ?? {})
        return [container, wrappedUpdate] as const
      } else if (option === 'ocfusion') {
        const [container, updateOCFusion] = await createOCFusionAnim(app, marginOpts)
        // Same as drone — driven by MediaPipe hand landmarks, not body pose
        const wrappedUpdate = (_pose: any) => updateOCFusion(rawRef.current.hands ?? [])
        return [container, wrappedUpdate] as const
      } else if (option === 'clown') {
        return await createClownAnim(app)
      } else if (option === 'pig') {
        return await createPigAnim(app)
      } else if (option === 'pignose') {
        return await createPigNoseAnim(app)
      }
      return null
    }

    let cancelled = false
    setAnimLoading(true)
    ;(async () => {
      console.log('Beginning animation load...')
      try {

      type AnimUpdate = (pose: typeof dataRef.current.mp_pose.pose) => void
      const animSlots: { container: PIXI.Container; update: AnimUpdate }[] = []
      const cornerAnims: ((hasPerson: boolean) => void)[] = []
      // QR mode: a single fade-prop instance (drone gif). Before lock-on, it
      // fades in and follows the code's own live on-screen position (from
      // the backend's decoded QR center) while QR_DRONE_PAYLOAD is visible.
      // The moment a guest shows that code, whichever tracked
      // person has a wrist closest to the code's position is assumed to be
      // the one holding it up — the drone locks onto that person's track id
      // (reusing this project's existing YOLO pose detection rather than a
      // separate face model), and from then on follows a point above their
      // head, not their face. It keeps following them — even after the code
      // is put away or a photo is taken — holding its last known position
      // on frames where their pose is briefly lost, until reset via
      // Settings. See the ticker below for the actual lock/follow logic.
      let qrDroneUpdate: ((target: { x: number; y: number } | undefined) => void) | undefined
      let qrDroneLastPos: { x: number; y: number } | undefined
      let qrLockedTrackId: number | undefined

      if (qrMode) {
        const [container, update] = await createSimpleFadePropAnim(app, {
          animUrl: qrDroneGif,
          kalman: { R: 0.01, Q: 5 },
          sizeFactor: 1,
        })
        animLayer.addChild(container)
        qrDroneUpdate = (target) => {
          update(target ? { x: target.x, y: target.y, size: CORNER_SIZE * 2, angle: 0 } : undefined)
        }
      } else if (gifOption === 'owl' || gifOption === 'bat' || gifOption === 'globe' || gifOption === 'drone' || gifOption === 'scuba' || gifOption === 'ocfusion' || gifOption === 'clown' || gifOption === 'pig' || gifOption === 'pignose') {
        // Scuba always runs a single instance regardless of multi-target mode —
        // it already does its own "closest person" selection internally across
        // all tracked people, so multiple instances would just render duplicate,
        // overlapping gifs on the same target.
        const count = isMulti && gifOption !== 'scuba' ? MAX_PEOPLE : 1
        const results = await Promise.all(
          Array.from({ length: count }, () => createAnimForGif(gifOption))
        )
        for (const result of results) {
          if (result) {
            const [container, update] = result
            animLayer.addChild(container)
            animSlots.push({ container, update })
          }
        }
      } else if (gifOption !== 'none') {
        const animUrl = GIF_URLS[gifOption]
        const corners = await Promise.all(
          CORNER_POSITIONS.map((pos) =>
            createSimpleFadePropAnim(app, {
              animUrl,
              kalman: { R: 0.01, Q: 5 },
              sizeFactor: 1,
            }).then(([container, update]) => {
              animLayer.addChild(container)
              return (hasPerson: boolean) => {
                update(hasPerson ? { x: pos.x, y: pos.y, size: CORNER_SIZE, angle: 0 } : undefined)
              }
            })
          )
        )
        cornerAnims.push(...corners)
      }
      // gifOption === 'none': no animSlots, no cornerAnims — raw video feed only

      const arrowCount = isMulti ? MAX_PEOPLE : 1
      const [arrows, banner] = await Promise.all([
        Promise.all(Array.from({ length: arrowCount }, () => createArrowPointer(app))),
        createBanner(app),
      ])
      for (const [container] of arrows) animLayer.addChild(container)
      app.stage.addChild(banner)
      bannerContainer = banner
      console.log('Animations added')

      const assignAnimSlots = createSlotAssigner<NormalizedLandmarkList>(animSlots.length)

      app.ticker.add(() => {
        if (isMulti && animSlots.length > 1) {
          // Multi-person: each person holds their own slot while tracked
          const bySlot = assignAnimSlots(dataRef.current.allPoses ?? {})
          for (let i = 0; i < animSlots.length; i++) {
            animSlots[i].update(bySlot[i] ?? [])
          }
        } else if (animSlots.length > 0) {
          // Single-person: use selected pose
          const curPose = dataRef.current.mp_pose?.pose
          if (curPose) animSlots[0].update(curPose)
        }

        const curPose = dataRef.current.mp_pose?.pose
        const hasPerson = !!(curPose && curPose.length > 0)
        for (const updateCorner of cornerAnims) updateCorner(hasPerson)

        if (qrDroneUpdate) {
          // dataRef.current.qrCodes/allPoses are still normalised [0,1]
          // fractions at this point (remapPoint only adjusts for margins,
          // it doesn't scale to pixels — the actual conversion happens via
          // convertPoint, same as every other character e.g. owl.ts does),
          // so convert to pixel space here before any position math.
          const droneCodeRaw = dataRef.current.qrCodes?.find((c) => c.payload === QR_DRONE_PAYLOAD)
          const droneCode = droneCodeRaw
            ? convertPoint({ x: droneCodeRaw.x, y: droneCodeRaw.y, z: 0 }, height, width)
            : undefined
          const allPosesRaw = dataRef.current.allPoses ?? {}
          const allPoses: { [id: number]: { x: number; y: number }[] } = {}
          for (const [idStr, pose] of Object.entries(allPosesRaw)) {
            allPoses[Number(idStr)] = pose.map((p) => convertPoint(p, height, width))
          }

          // qrDroneLocked persists globally across effect remounts, but
          // qrLockedTrackId is local to this mount — if the effect
          // remounted while locked (e.g. gifOption/isMulti changed), it'd
          // otherwise inherit "locked" with no id to follow and get stuck
          // forever. Treat that combination as unlocked so it can re-acquire.
          if ((!qrDroneLocked.get() || qrLockedTrackId === undefined) && droneCode) {
            // Whichever tracked person has a wrist closest to the code's
            // position is assumed to be the one holding it up. Falls back
            // to that person's nose if neither wrist is available (e.g.
            // arm out of frame) — still a reasonable "where is this person"
            // proxy for picking among multiple candidates.
            let bestId: number | undefined
            let bestDist = Infinity
            for (const [idStr, pose] of Object.entries(allPoses)) {
              const candidates = [pose[15], pose[16], pose[0]].filter(Boolean)
              for (const pt of candidates) {
                const dist = Math.hypot(pt.x - droneCode.x, pt.y - droneCode.y)
                if (dist < bestDist) {
                  bestDist = dist
                  bestId = Number(idStr)
                }
              }
            }
            if (bestId !== undefined) {
              qrLockedTrackId = bestId
              qrDroneLocked.set(true)
            }
          }

          if (qrDroneLocked.get() && qrLockedTrackId !== undefined) {
            // Locked: follow a point above the locked person's head, holding
            // the last known spot on frames where their pose is briefly lost
            // (e.g. momentarily out of frame) rather than disappearing.
            const lockedPose = allPoses[qrLockedTrackId]
            const headTop = lockedPose && headTopFromPose(lockedPose)
            if (headTop) qrDroneLastPos = headTop
            qrDroneUpdate(qrDroneLastPos)
          } else {
            // Not locked yet: follow the code's own live on-screen position,
            // visible only while the code itself is shown.
            qrDroneUpdate(droneCode ? { x: droneCode.x, y: droneCode.y } : undefined)
          }
        }
      })

      const assignArrowSlots = createSlotAssigner<NormalizedLandmarkList>(arrows.length)

      app.ticker.add(() => {
        const visible = pointerEnabled.get()
        for (const [container] of arrows) container.visible = visible
        if (!visible) return

        if (isMulti && arrows.length > 1) {
          // Same stable assignment as the anim slots — an arrow drifting
          // between people looks just as wrong as a mask doing it.
          const bySlot = assignArrowSlots(dataRef.current.allPoses ?? {})
          for (let i = 0; i < arrows.length; i++) {
            const [, updateArrow] = arrows[i]
            updateArrow(bySlot[i] ?? [])
          }
        } else {
          const curPose = dataRef.current.mp_pose?.pose
          if (curPose) arrows[0][1](curPose)
        }
      })

      app.ticker.add(() => {
        banner.visible = bannerEnabled.get()
      })
      } catch (e) {
        // Asset load failure (network error, ensureLoaded's 60s timeout,
        // etc.) previously left this IIFE as an unhandled rejection with
        // the video feed never reattached — now it's just a lost animation,
        // the feed keeps working since attachStream2Pixi's ticker is wired
        // up unconditionally above.
        console.warn('Animation load failed:', e)
      } finally {
        if (!cancelled) setAnimLoading(false)
      }
    })()

    photographerRef.current = async () => {
      // Captured photos get their own border/branding in the gallery
      // (see photoStrip.ts) instead of the live-preview banner overlay, so
      // force one render with it hidden right before grabbing the frame.
      const prevBannerVisible = bannerContainer?.visible ?? true
      if (bannerContainer) bannerContainer.visible = false
      app.renderer.render(app.stage)
      const imCanvas = postprocessPicture(app.renderer.view)
      if (bannerContainer) bannerContainer.visible = prevBannerVisible

      return imCanvas.toDataURL(
        // TODO: should these be configurable instead of hardcoded
        import.meta.env.VITE_IMG_UPLOAD_FORMAT,
        parseFloat(import.meta.env.VITE_IMG_UPLOAD_QUALITY),
      )
    }

    const debugPrintAnalysis = setInterval(() => {
      console.debug(rawRef.current)
    }, 10000)

    app.loader.load()

    return () => {
      cancelled = true
      try {
        clearInterval(debugPrintAnalysis)
        // NOTE: do NOT call app.loader.reset() here. With sharedLoader:true,
        // app.loader is the single global PIXI.Loader.shared instance reused
        // across every gif switch (that's the point — see the comment above
        // re: caching). reset() wipes loader.resources and aborts in-flight
        // loads on that shared instance, but doesn't touch our separate
        // `textureCache` store in pixi.ts's ensureLoaded — so the two caches
        // fall out of sync: an aborted load leaves textureCache stuck at
        // 'queued' forever (ensureLoaded never re-requests it, since it only
        // calls loader.add() when the cache entry is undefined), and a
        // completed load leaves textureCache pointing at a resource PIXI has
        // already discarded. Either way the gif silently never appears again
        // until a full page reload resets both caches. Just destroy this
        // app instance; the shared loader/textureCache persist correctly.
        app.destroy()
      } catch (e) {
        console.warn(e)
      }
      canvas.remove()
    }
  }, [height, width, gifOption, isRtspMode, isMulti, qrMode]) // including the ref currents here triggers an unnecessary rerender
  return (
    <>
      <div ref={divRef} {...props}></div>
      {animLoading && (
        <div tw='fixed inset-0 z-40 flex items-center justify-center pointer-events-none'>
          <div tw='w-16 h-16 border-4 border-white border-t-transparent rounded-full animate-spin' />
        </div>
      )}
      <video
        ref={videoRef}
        controls
        autoPlay
        muted
        tw='fixed z-50 w-48 bottom-0 left-9 invisible'
      ></video>
      {isRtspMode && (
        <img
          ref={imgRef}
          crossOrigin='anonymous'
          tw='fixed z-50 w-48 bottom-0 left-9 invisible'
          alt=''
        />
      )}
    </>
  )
}
