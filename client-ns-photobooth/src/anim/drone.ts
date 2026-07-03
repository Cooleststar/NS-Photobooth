import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import droneGif from '../assets/drone_anim/drone.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.02, Q: 1.5 }
const DRONE_SIZE_FACTOR = 0.22
const BOB_SPEED = 2.5
const BOB_AMPLITUDE_FACTOR = 0.014
const PALM_HOLD_TIME = 0.6

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

function getPalmUpForHand(
  pose: NormalizedLandmarkList,
  wristIdx: number,
  indexTipIdx: number,
  height: number,
  width: number,
): { x: number; y: number } | undefined {
  if (pose.length === 0) return undefined
  const wrist = pose[wristIdx]
  const indexTip = pose[indexTipIdx]
  if (!wrist || !indexTip) return undefined
  if (wrist.visibility! < 0.5 || indexTip.visibility! < 0.3) return undefined
  if (indexTip.y >= wrist.y) return undefined
  const p = convertPoint(wrist, height, width)
  return { x: p.x, y: p.y }
}

async function createHandDrone(
  app: PIXI.Application,
  wristIdx: number,
  indexTipIdx: number,
  droneSize: number,
  hoverOffset: number,
  bobAmplitude: number,
  bounds: FeedBounds,
) {
  const { height, width } = app.renderer
  const { ticker, loader } = app

  const container = new PIXI.Container()
  const sprite = await PIXI.ensureLoaded(loader, droneGif).then((r) => r.animation!.clone())
  sprite.anchor.set(0.5, 0.5)
  sprite.width = droneSize
  sprite.height = droneSize
  container.addChild(sprite)

  const initialState = () => {
    container.alpha = 0
    sprite.stop()
    sprite.currentFrame = 0
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
  }

  let wristX = 0
  let wristY = 0
  let bobTime = 0
  let palmHoldTimer = 0
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const rawWrist = getPalmUpForHand(pose, wristIdx, indexTipIdx, height, width)

    if (rawWrist) {
      palmHoldTimer = PALM_HOLD_TIME
      wristX = kf.x.filter(rawWrist.x)
      wristY = kf.y.filter(rawWrist.y)
    } else {
      palmHoldTimer = Math.max(0, palmHoldTimer - ticker.deltaMS / 1000)
    }

    const hasPerson = rawWrist !== undefined || palmHoldTimer > 0

    animManager.tracking = hasPerson
    const { time, state } = animManager

    const targetY = wristY - hoverOffset

    switch (state) {
      case 'exited':
        initialState()
        bobTime = 0
        break

      case 'entering': {
        container.alpha = 1
        if (!sprite.playing) sprite.play()
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)
        const progress = lerpEO(time, 0, ANIM.FADE)
        const startY = targetY - height * 0.2
        const ep = clampPos(wristX, startY + (targetY - startY) * progress, droneSize, bounds)
        container.position.set(ep.x, ep.y)
        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered': {
        if (!sprite.playing) sprite.play()
        sprite.alpha = 1
        container.alpha = 1
        bobTime += ticker.deltaMS / 1000
        const bob = Math.sin(bobTime * BOB_SPEED) * bobAmplitude
        const tp = clampPos(wristX, targetY + bob, droneSize, bounds)
        container.position.set(tp.x, tp.y)
        break
      }

      case 'lost': {
        bobTime += ticker.deltaMS / 1000
        const bob = Math.sin(bobTime * BOB_SPEED) * bobAmplitude
        const tp = clampPos(wristX, targetY + bob, droneSize, bounds)
        container.position.set(tp.x, tp.y)
        if (time >= ANIM.RETRACK) animManager.transition()
        break
      }

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

export async function createDroneAnim(
  app: PIXI.Application,
  margins = { mx: 30 / 1920, mt: 30 / 1080, mb: 30 / 1080 },
) {
  const { height, width } = app.renderer

  const bounds: FeedBounds = {
    left: margins.mx * width,
    right: (1 - margins.mx) * width,
    top: margins.mt * height,
    bottom: (1 - margins.mb) * height,
  }

  const droneSize = height * DRONE_SIZE_FACTOR
  const hoverOffset = droneSize
  const bobAmplitude = height * BOB_AMPLITUDE_FACTOR

  const [leftContainer, updateLeft] = await createHandDrone(
    app, 15, 19, droneSize, hoverOffset, bobAmplitude, bounds,
  )
  const [rightContainer, updateRight] = await createHandDrone(
    app, 16, 20, droneSize, hoverOffset, bobAmplitude, bounds,
  )

  const parentContainer = new PIXI.Container()
  parentContainer.addChild(leftContainer)
  parentContainer.addChild(rightContainer)

  const update = (pose: NormalizedLandmarkList) => {
    updateLeft(pose)
    updateRight(pose)
  }

  return [parentContainer, update] as const
}
