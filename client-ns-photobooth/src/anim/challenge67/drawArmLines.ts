import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'

// Same landmark indices repCounter.ts reads (shoulder->elbow->wrist per
// arm) - see that file for why these particular joints.
const LEFT_ARM: [number, number][] = [[11, 13], [13, 15]]
const RIGHT_ARM: [number, number][] = [[12, 14], [14, 16]]

/** 67 Mode's own visual feedback for arm tracking - deliberately separate
 * from anim/stream.ts's drawDebug/drawSkeleton (the "Debug Animation"
 * toggle's full-body skeleton) so it always shows during a round regardless
 * of that setting, and so a change to one doesn't risk the other. */
export function drawChallenge67ArmLines(
  ctx: CanvasRenderingContext2D,
  pose: NormalizedLandmarkList,
  width: number,
  height: number,
) {
  if (pose.length === 0) return

  ctx.save()
  // Video underneath is drawn mirrored (see createReceivingCtx) - flip to
  // match, same convention drawSkeleton uses.
  ctx.translate(width, 0)
  ctx.scale(-1, 1)

  const lineW = Math.max(3, width / 150)
  const dotR = Math.max(5, width / 100)

  const drawArm = (segments: [number, number][], color: string) => {
    ctx.lineWidth = lineW
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = color
    for (const [a, b] of segments) {
      const lmA = pose[a]
      const lmB = pose[b]
      if (!lmA || !lmB) continue
      if ((lmA.visibility ?? 1) < 0.5 || (lmB.visibility ?? 1) < 0.5) continue
      ctx.beginPath()
      ctx.moveTo(lmA.x * width, lmA.y * height)
      ctx.lineTo(lmB.x * width, lmB.y * height)
      ctx.stroke()
    }
    const wrist = pose[segments[segments.length - 1][1]]
    if (wrist && (wrist.visibility ?? 1) >= 0.5) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(wrist.x * width, wrist.y * height, dotR, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  drawArm(LEFT_ARM, '#0000ff')
  drawArm(RIGHT_ARM, '#0000ff')

  ctx.restore()
}
