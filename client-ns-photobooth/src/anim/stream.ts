import { drawLandmarks, NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import { PropDetection } from '../api/nicepipe'
import { calculateArmFromPose } from '../api/nicepipe/mpPose'

/** visualize information about pose for debugging */

export function drawDebug(
  ctx: CanvasRenderingContext2D,
  pose: NormalizedLandmarkList,
  propDets: PropDetection[],
  fps: number,
) {
  const { height, width } = ctx.canvas
  const arm = calculateArmFromPose(pose, height, width)[0]

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

  // pose trigger debug
  ctx.beginPath()
  if (arm == 'left') ctx.fillStyle = 'darkgreen'
  else if (arm == 'right') ctx.fillStyle = 'darkred'
  ctx.fillRect(0, 0, 150, 50)
  ctx.fill()

  // fps debug
  ctx.fillStyle = 'white'
  ctx.textBaseline = 'hanging'
  ctx.font = '48px serif'
  ctx.fillText(`${fps.toFixed(1)}hz`, 0, 0)
  ctx.strokeText(`${fps.toFixed(1)}hz`, 0, 0)

  // pose debug
  ctx.translate(width, 0)
  ctx.scale(-1, 1)
  drawLandmarks(ctx, pose, { color: '#FF0000', radius: width / 640 })

  ctx.restore()
}
/** adds bg as background to app & add ticker to update it */

export function attachStream2Pixi(
  app: PIXI.Application,
  bg: PIXI.SpriteSource,
) {
  const { height, width } = app.renderer
  const bgTexture = PIXI.Sprite.from(bg)
  bgTexture.height = height
  bgTexture.width = width
  bgTexture.position.set(0, 0)
  app.stage.addChild(bgTexture)
  app.ticker.add(() => bgTexture.texture.update())
}
