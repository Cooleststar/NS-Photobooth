import type { SelfieSegmentation as SelfieSegmentationClass } from '@mediapipe/selfie_segmentation'

import { BACKGROUND_OPTIONS, BackgroundOption } from '../store'

// 1 = the "landscape" model (256x144, tuned for wide/full-body framing and
// noticeably cheaper than model 0's 256x256 "general" model) — the better
// fit here since the model only ever has to find one person roughly
// centered in a landscape-oriented booth frame, not arbitrary photos.
const MODEL_SELECTION = 1

// The wasm/tflite/graph files this pulls in are NOT bundled by Vite — the
// mediapipe runtime fetches them itself via locateFile at runtime, so they're
// vendored as static files under public/mediapipe/selfie_segmentation/
// (copied from the installed npm package) rather than relying on Google's
// CDN, which the booth won't reach with "Disable Online Features" on.
const ASSET_BASE = '/mediapipe/selfie_segmentation'
const locateFile = (file: string) => `${ASSET_BASE}/${file}`

// @mediapipe/selfie_segmentation's own build (like every @mediapipe
// "solutions" JS package — see https://github.com/google/mediapipe/issues/2883)
// is a single IIFE that only ever assigns `window.SelfieSegmentation = ...`
// as a side effect; it has no `export` statement anywhere in the source. A
// real `import { SelfieSegmentation } from '@mediapipe/selfie_segmentation'`
// therefore fails at ES-module link time ("does not provide an export
// named..."), regardless of any Vite transform trickery — the browser's own
// module loader determines exports purely by statically scanning for
// `export` syntax before anything runs, and there is none here. Loading it
// as a classic (non-module) `<script>` sidesteps that entirely: this is
// exactly the loading style the file's own build expects, and it's still
// served from the local vendored copy, not a CDN.
declare global {
  interface Window {
    SelfieSegmentation?: new (config: {
      locateFile?: (file: string) => string
    }) => SelfieSegmentationClass
  }
}

let scriptLoadPromise: Promise<void> | undefined
function loadSelfieSegmentationScript(): Promise<void> {
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `${ASSET_BASE}/selfie_segmentation.js`
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('failed to load selfie_segmentation.js'))
      document.head.appendChild(script)
    })
  }
  return scriptLoadPromise
}

type MaskSource = HTMLCanvasElement | HTMLImageElement | ImageBitmap

export interface VirtualBackgroundController {
  setBackground: (option: BackgroundOption) => void
  /** Feeds the current raw (unmirrored) video frame into the segmentation
   * model if it isn't already busy on a previous one (or the model hasn't
   * finished loading yet) — never blocks or queues, since the model runs
   * slower than the video's own frame rate; drawComposited always just
   * uses whatever mask was produced most recently. */
  requestSegmentation: (source: CanvasImageSource) => void
  /** Draws `source` into `ctx` at (x, y, w, h), composited over the
   * selected background using the latest available segmentation mask.
   * Falls back to drawing `source` plain (no replacement) if no mask has
   * been produced yet or the background image hasn't finished loading —
   * so this is always safe to call even before the model's ready. */
  drawComposited: (
    ctx: CanvasRenderingContext2D,
    source: CanvasImageSource,
    x: number,
    y: number,
    w: number,
    h: number,
  ) => void
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const imgRatio = img.naturalWidth / img.naturalHeight
  const targetRatio = w / h
  let sx = 0
  let sy = 0
  let sw = img.naturalWidth
  let sh = img.naturalHeight
  if (imgRatio > targetRatio) {
    sw = sh * targetRatio
    sx = (img.naturalWidth - sw) / 2
  } else {
    sh = sw / targetRatio
    sy = (img.naturalHeight - sh) / 2
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
}

// The segmentation model (WASM + GL context, loaded via the classic
// <script> tag above) is effectively a page-lifetime singleton, not
// something scoped to any one component mount: Display.tsx's video effect
// remounts on plenty of unrelated changes (picking a different animation in
// AnimPicker, toggling QR Code Mode — both feed gifOptionsKey/qrMode in its
// dependency array), and the underlying mediapipe runtime does not support
// being torn down and reconstructed like that — an earlier version of this
// file exposed a close() called from that effect's cleanup, which after the
// *first* such remount silently and permanently broke segmentation for the
// rest of the page's life (no mask ever produced again, no error thrown).
// Memoizing the controller here, and never closing it, keeps exactly one
// instance alive for as long as the tab is open, independent of how many
// times Display's own effect remounts around it.
let singleton: VirtualBackgroundController | undefined

export function createVirtualBackground(): VirtualBackgroundController {
  if (singleton) return singleton

  let segmenter: SelfieSegmentationClass | undefined
  let latestMask: MaskSource | undefined
  let pending = false

  let loggedFirstMask = false
  let drawCompositeLoggedOnce = false
  loadSelfieSegmentationScript()
    .then(() => {
      const Ctor = window.SelfieSegmentation
      if (!Ctor) {
        console.warn('Virtual background: selfie_segmentation.js loaded but window.SelfieSegmentation is missing')
        return
      }
      const instance = new Ctor({ locateFile })
      instance.setOptions({ modelSelection: MODEL_SELECTION, selfieMode: false })
      instance.onResults((results) => {
        if (!loggedFirstMask) {
          loggedFirstMask = true
          console.info('Virtual background: first segmentation mask received', results.segmentationMask)
        }
        latestMask = results.segmentationMask
        pending = false
      })
      segmenter = instance
      console.info('Virtual background: segmentation model constructed, ready to segment')
    })
    .catch((e) => console.warn('Virtual background: failed to load segmentation model', e))

  const bgImages = {} as Record<BackgroundOption, HTMLImageElement>
  for (const key of Object.keys(BACKGROUND_OPTIONS) as BackgroundOption[]) {
    const img = new Image()
    img.src = BACKGROUND_OPTIONS[key].url
    bgImages[key] = img
  }
  let currentBg: BackgroundOption = Object.keys(BACKGROUND_OPTIONS)[0] as BackgroundOption

  // The masked person is composited here first, then drawn into the
  // caller's ctx as a single image — a separate canvas is required so the
  // 'destination-in' mask step below only erases *this* layer's own
  // pixels, not the background the caller may have already painted.
  const personCanvas = document.createElement('canvas')
  const personCtx = personCanvas.getContext('2d')!

  singleton = {
    setBackground: (option) => { currentBg = option },

    requestSegmentation: (source) => {
      if (!segmenter || pending) return
      pending = true
      // send()'s input type is narrower than CanvasImageSource (no
      // ImageBitmap, which the RTSP path uses) — the underlying graph just
      // draws whatever it's given, so this is safe at runtime.
      segmenter.send({ image: source as never }).catch((e) => {
        pending = false
        console.warn('Virtual background: segmentation send() failed', e)
      })
    },

    drawComposited: (ctx, source, x, y, w, h) => {
      const bgImg = bgImages[currentBg]
      if (!latestMask || !bgImg.complete || bgImg.naturalWidth === 0) {
        // Only worth logging once a mask has already arrived (i.e. still
        // falling back despite the model being ready) — a fallback before
        // that is just the normal brief startup window, not a problem.
        if (loggedFirstMask && !drawCompositeLoggedOnce) {
          drawCompositeLoggedOnce = true
          console.warn('Virtual background: still falling back to plain video despite having a mask', {
            bgImgComplete: bgImg.complete,
            bgImgNaturalWidth: bgImg.naturalWidth,
          })
        }
        ctx.drawImage(source, x, y, w, h)
        return
      }
      if (!drawCompositeLoggedOnce) {
        drawCompositeLoggedOnce = true
        console.info('Virtual background: compositing branch active (mask + background both ready)')
      }

      if (personCanvas.width !== w || personCanvas.height !== h) {
        personCanvas.width = w
        personCanvas.height = h
      }
      personCtx.clearRect(0, 0, w, h)
      personCtx.drawImage(source, 0, 0, w, h)
      personCtx.globalCompositeOperation = 'destination-in'
      personCtx.drawImage(latestMask, 0, 0, w, h)
      personCtx.globalCompositeOperation = 'source-over'

      drawCover(ctx, bgImg, x, y, w, h)
      ctx.drawImage(personCanvas, x, y, w, h)
    },
  }
  return singleton
}
