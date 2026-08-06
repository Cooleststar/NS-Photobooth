import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'

// MediaPipe Pose 33-keypoint connections — main bones only (no wrist/foot sub-triangles)
const MP_POSE_CONNECTIONS: [number, number][] = [
  // face: nose → eyes → ears
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],                    // mouth corners
  // shoulders
  [11, 12],
  // left arm
  [11, 13], [13, 15],
  // right arm
  [12, 14], [14, 16],
  // torso
  [11, 23], [12, 24], [23, 24],
  // left leg
  [23, 25], [25, 27], [27, 31],
  // right leg
  [24, 26], [26, 28], [28, 32],
]

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  pose: NormalizedLandmarkList,
  width: number,
  height: number,
) {
  const lineW = Math.max(2, width / 200)
  const dotR  = Math.max(3, width / 130)

  ctx.lineWidth = lineW
  ctx.lineJoin = 'round'
  ctx.lineCap  = 'round'
  ctx.strokeStyle = '#00FF41'  // matrix green

  for (const [a, b] of MP_POSE_CONNECTIONS) {
    const lmA = pose[a]
    const lmB = pose[b]
    if (!lmA || !lmB) continue
    if ((lmA.visibility ?? 1) < 0.3 || (lmB.visibility ?? 1) < 0.3) continue
    ctx.beginPath()
    ctx.moveTo(lmA.x * width, lmA.y * height)
    ctx.lineTo(lmB.x * width, lmB.y * height)
    ctx.stroke()
  }

  ctx.fillStyle = '#FFFFFF'
  for (const lm of pose) {
    if ((lm.visibility ?? 1) < 0.3) continue
    ctx.beginPath()
    ctx.arc(lm.x * width, lm.y * height, dotR, 0, Math.PI * 2)
    ctx.fill()
  }
}
import * as PIXI from '../pixi'
import { PropDetection } from '../api/nicepipe'


/** visualize information about pose for debugging */

export function drawDebug(
  ctx: CanvasRenderingContext2D,
  pose: NormalizedLandmarkList,
  propDets: PropDetection[],
  fps: number,
) {
  const { height, width } = ctx.canvas

  ctx.save()

  // props debug
  ctx.lineWidth = 4
  ctx.strokeStyle = 'green'
  for (const [_, [pt1, pt2, pt3, pt4]] of propDets) {
    ctx.beginPath()
    ctx.moveTo(pt1[0] * width, pt1[1] * height)
    ctx.lineTo(pt2[0] * width, pt2[1] * height)
    ctx.lineTo(pt3[0] * width, pt3[1] * height)
    ctx.lineTo(pt4[0] * width, pt4[1] * height)
    ctx.lineTo(pt1[0] * width, pt1[1] * height)
    ctx.stroke()
  }

  ctx.restore()
  ctx.save()

  // pose debug — skeleton lines + joint dots
  ctx.translate(width, 0)
  ctx.scale(-1, 1)
  drawSkeleton(ctx, pose, width, height)

  ctx.restore()
  ctx.save()

  // FPS counter — drawn last, unflipped, so it always reads left-to-right
  // regardless of the mirrored video underneath. Not gated on pose/props
  // being present, since hand-only characters (e.g. drone) have no pose
  // data at all and should still show FPS.
  const fpsText = `${Math.round(fps)} FPS`
  ctx.font = 'bold 28px monospace'
  ctx.textBaseline = 'top'
  const pad = 10
  const metrics = ctx.measureText(fpsText)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.fillRect(pad - 6, pad - 4, metrics.width + 12, 36)
  ctx.fillStyle = fps < 15 ? '#ff5555' : fps < 24 ? '#ffcc00' : '#55ff55'
  ctx.fillText(fpsText, pad, pad)

  ctx.restore()
}
/** adds bg as background to app & add ticker to update it */

export function attachStream2Pixi(
  app: PIXI.Application,
  bg: HTMLCanvasElement,
) {
  const { height, width } = app.renderer
  const bgTexture = PIXI.Sprite.from(bg)
  bgTexture.height = height
  bgTexture.width = width
  bgTexture.position.set(0, 0)
  // Mipmapping is on globally (pixi.ts), but this sprite is always rendered
  // 1:1 against the canvas size — no real downscaling ever happens, so
  // mipmaps give no benefit here, just wasted regeneration work every update().
  bgTexture.texture.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF
  app.stage.addChild(bgTexture)
  app.ticker.add(() => bgTexture.texture.update())
}
