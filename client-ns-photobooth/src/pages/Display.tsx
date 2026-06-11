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
import { createBanner } from '../anim/banner'
import { createOwlAnim } from '../anim/owl'
import { createOwlPropAnim } from '../anim/owlProp'
import { createSimpleFadePropAnim } from '../anim/simpleFadeProp'
import { attachStream2Pixi, drawDebug } from '../anim/stream'
import { Analysis, PropDetection } from '../api/nicepipe'
import { convert2mpPose } from '../api/nicepipe/mmPose'
import { calculateArmFromPose } from '../api/nicepipe/mpPose'
import { createTargetCalculator } from '../api/nicepipe/propDetection'
import { useNiceROSAnalysis } from '../api/niceRos'
import globeGif from '../assets/globe.gif'
import laptopGif from '../assets/laptop.gif'
import anafiGif from '../assets/parrot_idle.gif'
import v15Gif from '../assets/v15_redesigned_idle.gif'
import * as PIXI from '../pixi'
import {
  GifOption,
  GIF_OPTIONS,
  bannerEnabled,
  camSize,
  debugEnabled,
  nicepipeURL,
  owlEnabled,
  pointerEnabled,
  poseInd,
  selectedDevice,
  selectedGif,
} from '../store'

const GIF_URLS: Record<Exclude<GifOption, 'owl'>, string> = {
  globe: globeGif,
  parrot: anafiGif,
  laptop: laptopGif,
  v15: v15Gif,
}

const MARGIN_X = 270 / 1920
const MARGIN_T = 40 / 1080
const MARGIN_B = 270 / 1080

// const MARGIN_X = 0
// const MARGIN_T = 0
// const MARGIN_B = 0

function postprocessPicture(pic: HTMLCanvasElement) {
  const { width, height } = pic
  const tmpCanvas = document.createElement('canvas')
  tmpCanvas.width = width
  tmpCanvas.height = height

  const ctx = tmpCanvas.getContext('2d')!
  ctx.drawImage(pic, 0, 0)

  const mx = MARGIN_X * width
  const mt = MARGIN_T * height
  const mb = MARGIN_B * height
  const iw = width - 2 * mx
  const ih = height - mt - mb

  // flip specifically the picture, excluding borders
  ctx.save()
  ctx.translate(width, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(pic, mx, mt, iw, ih, mx, mt, iw, ih)
  ctx.restore()
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
      const imgWidth =
        img instanceof HTMLImageElement ? img.naturalWidth : img.videoWidth
      const imgHeight =
        img instanceof HTMLImageElement ? img.naturalHeight : img.videoHeight

      const fps = measureFPS()
      ctx.save()
      ctx.translate(width, 0)
      ctx.scale(-1, 1)
      //ctx.drawImage(img, 0, 0, width, height)

      // calculate positionings and stuff
      const xMargin = MARGIN_X * width
      const btmMargin = MARGIN_B * height
      // const yMargin = MARGIN_T * height
      const widthTarget = width - 2 * xMargin
      const heightTarget = (widthTarget / imgWidth) * imgHeight
      const yMargin = height - heightTarget - btmMargin

      ctx.drawImage(img, xMargin, yMargin, widthTarget, heightTarget)
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

      if (debugEnabled.get()) drawDebug(ctx, pose, propDets, fps)
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
  const divRef = useRef<HTMLDivElement>(null)

  const deviceId = useStore(selectedDevice)
  const camRes = useStore(camSize)
  const url = useStore(nicepipeURL)
  const gifOption = useStore(selectedGif)

  const targetFinder = createTargetCalculator(height, width)

  // Auto-select the first available camera if none is selected
  useEffect(() => {
    if (deviceId) return
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const cam = devices.find((d) => d.kind === 'videoinput')
      if (cam) selectedDevice.set(cam.deviceId)
    })
  }, [])

  const setVideo = useCallback((stream: MediaStream) => {
    if (!videoRef.current) return
    videoRef.current.srcObject = stream
  }, [])

  useCam({ deviceId, videoConstraints: camRes, videoCallback: setVideo })

  useNiceROS(url, { enabled: true })

  useNiceRTC(deviceId, {
    enabled: !!deviceId,
    mode: 'send',
    videoConstraints: camRes,
    videoCallback: setVideo,
  })

  useNiceROSAnalysis(rawRef)

  // Send video frames to backend pose detector at /video endpoint
  useEffect(() => {
    if (!deviceId) return
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
  }, [deviceId, url])

  useEffect(() => {
    if (!videoRef.current) return
    if (deviceId) return
    videoRef.current.srcObject = null
  }, [deviceId])

  useEffect(() => {
    const divElm = divRef.current
    const video = videoRef.current
    if (!divElm) return
    if (!video) return

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

    let [canvas, update] = createReceivingCtx(videoRef, dataRef, {
      width,
      height,
    })

    attachStream2Pixi(app, canvas)
    ;(async () => {
      console.log('Beginning animation load...')

      // Create the main arm-gesture animation based on selected GIF
      let mainAnimContainer: PIXI.Container
      let updateMainAnim: (pose: typeof dataRef.current.mp_pose.pose) => void
      if (gifOption === 'owl') {
        const [container, update] = await createOwlAnim(app)
        mainAnimContainer = container
        updateMainAnim = update
      } else {
        const [container, update] = await createSimpleFadePropAnim(app, {
          animUrl: GIF_URLS[gifOption],
          kalman: { R: 0.01, Q: 5 },
          sizeFactor: 1.5,
        })
        mainAnimContainer = container
        updateMainAnim = (pose) => {
          if (!pose) return
          const [, coords] = calculateArmFromPose(pose, height, width)
          update(coords ? {
            x: coords.x,
            y: coords.y,
            size: coords.length * 2.5,
            angle: (coords.angle * 180) / Math.PI,
          } : undefined)
        }
      }

      const [
        [arrow, updateArrow],
        [owlProp, updateOwlProp],
        [laptopProp, updateLaptopProp],
        [v15Prop, updateV15Prop],
        [anafiProp, updateAnafiProp],
        banner,
      ] = await Promise.all([
        createArrowPointer(app),
        createOwlPropAnim(app, {
          kalman: { R: 0.01, Q: 5 },
          sizeFactor: 1.35,
          xOffset: -0.03,
          flip: true,
        }),
        createSimpleFadePropAnim(app, {
          animUrl: globeGif,
          kalman: { R: 0.01, Q: 5 },
          xOffset: -0.06,
          yOffset: -0.15,
        }),
        createSimpleFadePropAnim(app, {
          animUrl: v15Gif,
          kalman: { R: 0.01, Q: 3 },
          sizeFactor: 0.9,
          flip: true,
        }),
        createSimpleFadePropAnim(app, {
          animUrl: anafiGif,
          kalman: { R: 0.01, Q: 3 },
          sizeFactor: 0.9,
          xOffset: -0.04,
          flip: true,
        }),
        createBanner(app),
      ])
      app.stage.addChild(mainAnimContainer)
      app.stage.addChild(owlProp)
      app.stage.addChild(laptopProp)
      app.stage.addChild(v15Prop)
      app.stage.addChild(anafiProp)
      app.stage.addChild(banner)
      app.stage.addChild(arrow)
      console.log('Animations added')

      // when its too expensive to reconstruct the app so it has to be done imperatively
      app.ticker.add(() => update(rawRef.current, poseInd.get()))
      app.ticker.add(() => {
        mainAnimContainer.visible = owlEnabled.get()
        const curPose = dataRef.current.mp_pose?.pose
        if (curPose) updateMainAnim(curPose)
      })

      app.ticker.add(() => {
        arrow.visible = pointerEnabled.get()
        const curPose = dataRef.current.mp_pose?.pose
        if (curPose) updateArrow(curPose)
      })

      app.ticker.add(() => {
        banner.visible = bannerEnabled.get()
      })

      app.ticker.add(() => {
        const curPropDets = dataRef.current.kp ?? []
        updateOwlProp(targetFinder('owl', curPropDets))
        updateLaptopProp(targetFinder('laptop', curPropDets))
        updateV15Prop(targetFinder('v15', curPropDets))
        updateAnafiProp(targetFinder('anafi', curPropDets))
        // updateLaptop2Prop(targetFinder('laptop2', curPropDets))
      })
    })()

    photographerRef.current = async () => {
      const imCanvas = postprocessPicture(app.renderer.view)
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
  }, [height, width, gifOption]) // including the ref currents here triggers an unnecessary rerender
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
    </>
  )
}
