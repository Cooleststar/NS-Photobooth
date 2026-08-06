import { useStore } from '@nanostores/preact'
import { useCam, useNiceROS, useNiceRTC } from 'nice-ros-react'
import {
  ComponentProps,
  MutableRefObject,
  RefObject,
  useCallback,
  useEffect,
  useRef,
} from 'react'
import 'twin.macro'
import { createArrowPointer } from '../anim/arrow'
import { createBatAnim } from '../anim/bat'
import { createBanner } from '../anim/banner'
import { createDroneAnim } from '../anim/drone'
import { createGlobeAnim } from '../anim/globe'
import { createOwlAnim } from '../anim/owl'
import { createScubaAnim } from '../anim/scuba'
import { createSimpleFadePropAnim } from '../anim/simpleFadeProp'
import { attachStream2Pixi, drawDebug } from '../anim/stream'
import { Analysis, PropDetection } from '../api/nicepipe'
import { convert2mpPose } from '../api/nicepipe/mmPose'
import { useNiceROSAnalysis } from '../api/niceRos'
import laptopGif from '../assets/laptop_anim/laptop.gif'
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
  HIKVISION_IPS,
  RTSP_BASE,
  cameraSource,
  customRtspURL,
  poseInd,
  selectedDevice,
  selectedGif,
} from '../store'

const GIF_URLS: Record<Exclude<GifOption, 'owl' | 'bat' | 'globe' | 'drone' | 'scuba' | 'none'>, string> = {
  laptop: laptopGif,
}

// Which backend model(s) each character actually needs — owl/bat/globe read
// body pose only, drone reads hand landmarks only (ignores pose entirely),
// laptop is a fixed-position fade prop that reads neither, scuba needs both
// (pose for the nose position, hands for the pinch/wave gesture). Told to
// the backend via POST /detection_mode so it skips idle models per-frame
// instead of running YOLO/ViTPose/MediaPipe Hands unconditionally.
const DETECTION_MODE_BY_GIF: Record<GifOption, 'pose' | 'hands' | 'none' | 'both'> = {
  none: 'none',
  owl: 'pose',
  bat: 'pose',
  globe: 'pose',
  drone: 'hands',
  laptop: 'none',
  scuba: 'both',
}

const MARGIN_X = 30 / 1920
const MARGIN_T = 30 / 1080
const MARGIN_B = 30 / 1080

function postprocessPicture(pic: HTMLCanvasElement) {
  const { width, height } = pic
  const tmpCanvas = document.createElement('canvas')
  tmpCanvas.width = width
  tmpCanvas.height = height

  // capture exactly what's shown live — no extra flip, so the saved
  // photo matches the on-screen (mirrored) preview
  const ctx = tmpCanvas.getContext('2d')!
  ctx.drawImage(pic, 0, 0)
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

      // For debug, prefer real 33-pt MediaPipe pose (better head) over YOLO
      const rawDebugPose = dataRef.current.mp_debug_pose
      const debugPose = rawDebugPose
        ? rawDebugPose.map((p) => {
            const [dx, dy] = remapPoint(p.x, p.y, width / height, imgWidth / imgHeight)
            return { ...p, x: dx, y: dy }
          })
        : pose
      if (debugEnabled.get()) drawDebug(ctx, debugPose, propDets, fps)
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

  const deviceId = useStore(selectedDevice)
  const camRes = useStore(camSize)
  const url = useStore(nicepipeURL)
  const gifOption = useStore(selectedGif)
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
  useEffect(() => {
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const mode = DETECTION_MODE_BY_GIF[gifOption] ?? 'both'

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
  }, [gifOption])

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
        // to the camera) plus raw hand landmarks — neither is the single
        // `pose` arg this slot system passes, so read both directly.
        const wrappedUpdate = (_pose: any) =>
          updateScuba(dataRef.current.allPoses ?? {}, rawRef.current.hands ?? [])
        return [container, wrappedUpdate] as const
      }
      return null
    }

    ;(async () => {
      console.log('Beginning animation load...')

      type AnimUpdate = (pose: typeof dataRef.current.mp_pose.pose) => void
      const animSlots: { container: PIXI.Container; update: AnimUpdate }[] = []
      const cornerAnims: ((hasPerson: boolean) => void)[] = []

      if (gifOption === 'owl' || gifOption === 'bat' || gifOption === 'globe' || gifOption === 'drone' || gifOption === 'scuba') {
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

      app.ticker.add(() => update(rawRef.current, poseInd.get()))

      app.ticker.add(() => {
        if (isMulti && animSlots.length > 1) {
          // Multi-person: assign each detected person to an animation slot
          const allPoses = dataRef.current.allPoses ?? {}
          const ids = Object.keys(allPoses).map(Number)
          for (let i = 0; i < animSlots.length; i++) {
            if (i < ids.length) {
              animSlots[i].update(allPoses[ids[i]])
            } else {
              animSlots[i].update([])
            }
          }
        } else if (animSlots.length > 0) {
          // Single-person: use selected pose
          const curPose = dataRef.current.mp_pose?.pose
          if (curPose) animSlots[0].update(curPose)
        }

        const curPose = dataRef.current.mp_pose?.pose
        const hasPerson = !!(curPose && curPose.length > 0)
        for (const updateCorner of cornerAnims) updateCorner(hasPerson)
      })

      app.ticker.add(() => {
        const visible = pointerEnabled.get()
        for (const [container] of arrows) container.visible = visible
        if (!visible) return

        if (isMulti && arrows.length > 1) {
          const allPoses = dataRef.current.allPoses ?? {}
          const ids = Object.keys(allPoses).map(Number)
          for (let i = 0; i < arrows.length; i++) {
            const [, updateArrow] = arrows[i]
            updateArrow(i < ids.length ? allPoses[ids[i]] : [])
          }
        } else {
          const curPose = dataRef.current.mp_pose?.pose
          if (curPose) arrows[0][1](curPose)
        }
      })

      app.ticker.add(() => {
        banner.visible = bannerEnabled.get()
      })
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
      try {
        clearInterval(debugPrintAnalysis)
        app.loader?.reset()
        app.destroy()
      } catch (e) {
        console.warn(e)
      }
      canvas.remove()
    }
  }, [height, width, gifOption, isRtspMode, isMulti]) // including the ref currents here triggers an unnecessary rerender
  return (
    <>
      <div ref={divRef} {...props}></div>
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
