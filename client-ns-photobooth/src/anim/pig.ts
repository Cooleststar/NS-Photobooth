import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import pigImg from '../assets/Pig/PigFace.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }
// A mask needs to extend past the ears/chin to actually cover the face,
// not just span the raw ear-to-ear distance. Same approach as clown.ts.
const FACE_SIZE_FACTOR = 2.2

/** Face center/size/tilt from MP-33 pose landmarks (nose=0, ears=7/8) —
 * there's no dedicated face-mesh detector in this pipeline, so the sparse
 * face points already present in body pose are reused, same as
 * calculateOwlSize/calculateBatSize and clown.ts's getFaceTarget. */
function getFaceTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const nose = pose[0]
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!nose || !leftEar || !rightEar) return undefined
  if ((nose.visibility ?? 1) < 0.5) return undefined
  if ((leftEar.visibility ?? 1) < 0.3 && (rightEar.visibility ?? 1) < 0.3) return undefined

  const n = convertPoint(nose, height, width)
  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)

  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  // Head tilt, from the ear-to-ear line — so the mask rotates with the head
  // instead of always staying perfectly upright.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  return { x: n.x, y: n.y, size: earDist * FACE_SIZE_FACTOR, angle }
}

export async function createPigAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, pigImg)
  const sprite = PIXI.Sprite.from(texture!)
  sprite.anchor.set(0.5, 0.5)
  container.addChild(sprite)

  const initialState = () => {
    container.alpha = 0
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    angle: new KalmanFilter(KF_PARAMS),
  }

  let x = 0
  let y = 0
  let size = 200
  let angle = 0
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const face = getFaceTarget(pose, height, width)
    if (face) {
      x = kf.x.filter(face.x)
      y = kf.y.filter(face.y)
      size = kf.size.filter(face.size)
      angle = kf.angle.filter(face.angle)
    }

    sprite.width = sprite.height = size
    container.rotation = angle

    animManager.tracking = !!face
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        break

      case 'entering':
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        container.position.set(x, y)
        if (time >= ANIM.FADE) animManager.transition()
        break

      case 'entered':
        container.alpha = 1
        container.position.set(x, y)
        break

      case 'lost':
        switch (true) {
          case time < ANIM.RETRACK:
            break
          default:
            animManager.transition()
        }
        break

      case 'exiting':
        container.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
        if (time >= ANIM.FADE) {
          initialState()
          animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [container, update] as const
}
