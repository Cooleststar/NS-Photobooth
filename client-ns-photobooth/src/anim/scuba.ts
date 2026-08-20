import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import scubaGif from '../assets/cat_anim/scuba.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// Person selection: gif follows whoever is closest to the camera (largest
// on-screen shoulder width). A new person must be meaningfully closer, and
// stay that way briefly, before the target switches, so two people standing
// at similar distance don't cause flicker.
const TARGET_SWITCH_MARGIN = 1.15
const TARGET_SWITCH_HOLD = 0.5

// Placement relative to the tracked person, in multiples of shoulder width.
const SIDE_OFFSET = 1.3   // horizontal gap from torso center to gif center
const DROP_OFFSET = 0.3   // sits slightly below shoulder line
const SIZE_FACTOR = 1.8
const MIN_SIZE = 80

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

// ---------------------------------------------------------------------------
// Person selection — closest to camera, by on-screen shoulder width
// ---------------------------------------------------------------------------

function getTorso(pose: NormalizedLandmarkList, height: number, width: number) {
  const ls = pose[11]
  const rs = pose[12]
  if (!ls || !rs) return undefined
  if ((ls.visibility ?? 1) < 0.5 || (rs.visibility ?? 1) < 0.5) return undefined
  const l = convertPoint(ls, height, width)
  const r = convertPoint(rs, height, width)
  const shoulderWidth = Math.hypot(l.x - r.x, l.y - r.y)
  if (shoulderWidth < 1) return undefined
  return {
    center: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 },
    shoulderWidth,
  }
}

type Torso = NonNullable<ReturnType<typeof getTorso>>

function createPersonSelector() {
  let lockedId: number | undefined
  let candidateId: number | undefined
  let candidateTimer = 0

  return (
    allPoses: { [id: number]: NormalizedLandmarkList },
    height: number,
    width: number,
    deltaSec: number,
  ): { id: number; torso: Torso } | undefined => {
    const torsos = Object.entries(allPoses)
      .map(([id, pose]) => ({ id: Number(id), torso: getTorso(pose, height, width) }))
      .filter((e): e is { id: number; torso: Torso } => !!e.torso)

    if (torsos.length === 0) {
      lockedId = undefined
      candidateId = undefined
      candidateTimer = 0
      return undefined
    }

    torsos.sort((a, b) => b.torso.shoulderWidth - a.torso.shoulderWidth)
    const best = torsos[0]
    const locked = torsos.find((t) => t.id === lockedId)

    if (!locked) {
      lockedId = best.id
      candidateId = undefined
      candidateTimer = 0
    } else if (
      best.id !== lockedId &&
      best.torso.shoulderWidth > locked.torso.shoulderWidth * TARGET_SWITCH_MARGIN
    ) {
      if (candidateId !== best.id) {
        candidateId = best.id
        candidateTimer = 0
      }
      candidateTimer += deltaSec
      if (candidateTimer >= TARGET_SWITCH_HOLD) {
        lockedId = best.id
        candidateId = undefined
        candidateTimer = 0
      }
    } else {
      candidateId = undefined
      candidateTimer = 0
    }

    return torsos.find((t) => t.id === lockedId) ?? best
  }
}

// ---------------------------------------------------------------------------
// Scuba animation — sits beside whoever is closest to the camera. No gesture
// required; it appears as soon as a person's shoulders are visible.
// ---------------------------------------------------------------------------

export async function createScubaAnim(
  app: PIXI.Application,
  margins = { mx: 30 / 1920, mt: 30 / 1080, mb: 30 / 1080 },
) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const bounds: FeedBounds = {
    left: margins.mx * width,
    right: (1 - margins.mx) * width,
    top: margins.mt * height,
    bottom: (1 - margins.mb) * height,
  }

  const container = new PIXI.Container()
  const sprite = await PIXI.ensureLoaded(loader, scubaGif).then((r) => r.animation!.clone())
  sprite.anchor.set(0.5, 0.5)
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
    size: new KalmanFilter(KF_PARAMS),
  }
  const pickPerson = createPersonSelector()
  const animManager = new AnimStateManager()

  let targetX = 0
  let targetY = 0
  let scubaSize = 150

  const update = (allPoses: { [id: number]: NormalizedLandmarkList }) => {
    const deltaSec = ticker.deltaMS / 1000
    const person = pickPerson(allPoses, height, width, deltaSec)

    if (person) {
      const { center, shoulderWidth } = person.torso
      // Put it on whichever side has more room, so it doesn't get shoved
      // back over the person by clampPos when they stand near a feed edge.
      const side = bounds.right - center.x >= center.x - bounds.left ? 1 : -1
      targetX = kf.x.filter(center.x + side * shoulderWidth * SIDE_OFFSET)
      targetY = kf.y.filter(center.y + shoulderWidth * DROP_OFFSET)
      scubaSize = kf.size.filter(Math.max(MIN_SIZE, shoulderWidth * SIZE_FACTOR))
    }

    animManager.tracking = !!person
    const { time, state } = animManager

    sprite.height = sprite.width = scubaSize

    switch (state) {
      case 'exited':
        initialState()
        break

      case 'entering': {
        container.alpha = 1
        if (!sprite.playing) sprite.play()
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)
        const ep = clampPos(targetX, targetY, scubaSize, bounds)
        container.position.set(ep.x, ep.y)
        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered': {
        if (!sprite.playing) sprite.play()
        sprite.alpha = 1
        container.alpha = 1
        const ep = clampPos(targetX, targetY, scubaSize, bounds)
        container.position.set(ep.x, ep.y)
        break
      }

      case 'lost':
        // Brief pose dropouts shouldn't make it vanish — hold position until
        // the retrack window expires, same as clown/owl/bat.
        if (time >= ANIM.RETRACK) animManager.transition()
        break

      case 'exiting':
        container.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
        if (time >= ANIM.FADE) {
          initialState()
          animManager.transition()
        }
        break
    }

    animManager.update(deltaSec)
  }

  return [container, update] as const
}
