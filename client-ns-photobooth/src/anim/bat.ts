import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import batFlyGif from '../assets/Bat_anim/Bat.gif'
import batSwoopGif from '../assets/Bat_anim/bat_swoop.gif'
import batVanishGif from '../assets/Bat_anim/bat_vanish.gif'
import batRestPng from '../assets/Bat_anim/Bat_rest.png'

/** anim duration & timing config */
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
  FLY_LOOPS: 2,
}

// R is system noisiness, Q is measurement noisiness
const KF_PARAMS = { R: 0.03, Q: 2 }

const BAT_MARGIN_B = 0.27
// Resting pose rendered a bit smaller than the shared batSize, on request.
const REST_SIZE_FACTOR = 0.75
// Where along the forearm (elbow->wrist) the bat lands, as a fraction of
// that segment — 0 would be the elbow, 1 the wrist itself. Kept short of 1 so
// the bat perches on the forearm rather than on the hand.
const FOREARM_LAND_RATIO = 0.75
// Max allowed angle (degrees) between the upper arm (shoulder->elbow) and
// forearm (elbow->wrist) before the arm no longer counts as "straight" —
// the bat only lands/stays on a fully extended arm; bending the elbow past
// this makes getPalmTarget return undefined, which reads as tracking lost
// and sends the bat flying off (see the 'lost'/'exiting' states below).
// Widened 25 -> 40 on request, to make the bat easier to summon — a
// slightly bent elbow now still counts as "straight enough."
const ARM_STRAIGHT_MAX_DEVIATION_DEG = 40

// Allowed range (degrees) for the angle between the upper arm (shoulder->elbow)
// and the torso (shoulder->hip, same side) — this is "how far the arm is held
// away from the body," not the elbow bend above. 90 degrees is a horizontal,
// T-pose-style arm; the arm must land in [MIN, MAX] around that, so a straight
// arm hanging down at the side (~0 degrees) or raised straight overhead
// (~180 degrees) no longer qualifies, only one held out roughly level.
// Widened 80-100 -> 60-120, then narrowed to 70-110 on request, alongside
// the straightness tolerance above, so the arm doesn't need to be held at
// as precise an angle.
const ARM_AWAY_FROM_BODY_MIN_DEG = 70
const ARM_AWAY_FROM_BODY_MAX_DEG = 120

// Debounce for the raw per-frame arm qualification above, same pattern as
// drone.ts's PALM_HOLD_TIME/PALM_CONFIRM_TIME. Without this, a bat that's
// already 'entered' dropped straight to 'lost' (then 'exiting'/'entering'
// again on requalifying) the instant any single frame's pose estimate
// nudged one landmark's visibility or one angle a hair past its threshold —
// which reads as bats repeatedly appearing and disappearing on an arm that
// never actually moved. Adding the hip-dependent away-from-body check made
// this much more visible: hip tracking is noisier than shoulder/elbow/wrist
// at typical photobooth range, and it's now a 4-landmark, 3-threshold
// condition that all has to hold on the very same frame.
const ARM_HOLD_TIME = 0.4
const ARM_CONFIRM_TIME = 0.15

type ArmSide = 'left' | 'right'

/** Evaluates ONE specific arm (not "whichever is more confident") against
 * every qualification check — visibility, elbow straightness, and away-from-
 * body angle. Split out from getForearmTarget so a caller can pin down which
 * side to check, rather than always re-picking by confidence every frame. */
function evaluateArm(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  side: ArmSide,
) {
  const useLeft = side === 'left'
  const s = pose[useLeft ? 11 : 12]
  const e = pose[useLeft ? 13 : 14]
  const w = pose[useLeft ? 15 : 16]
  const h = pose[useLeft ? 23 : 24]
  // 0.5 -> 0.35 on request, alongside the angle tolerances below, so a
  // slightly-occluded or edge-of-frame arm still qualifies.
  const vis = Math.min(s?.visibility ?? 0, e?.visibility ?? 0, w?.visibility ?? 0, h?.visibility ?? 0)
  if (vis < 0.35) return undefined

  const shoulder = convertPoint(s, height, width)
  const elbow = convertPoint(e, height, width)
  const wrist = convertPoint(w, height, width)
  const hip = convertPoint(h, height, width)

  const upperArm = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y }
  const forearm = { x: wrist.x - elbow.x, y: wrist.y - elbow.y }
  const upperArmLen = Math.hypot(upperArm.x, upperArm.y)
  const forearmLen = Math.hypot(forearm.x, forearm.y)
  if (upperArmLen < 1 || forearmLen < 1) return undefined

  const cosDeviation =
    (upperArm.x * forearm.x + upperArm.y * forearm.y) / (upperArmLen * forearmLen)
  const maxCos = Math.cos((ARM_STRAIGHT_MAX_DEVIATION_DEG * Math.PI) / 180)
  if (cosDeviation < maxCos) return undefined

  // "Away from the body" — angle between the upper arm and the torso
  // (shoulder->hip, same side), not the elbow-straightness check above.
  const torso = { x: hip.x - shoulder.x, y: hip.y - shoulder.y }
  const torsoLen = Math.hypot(torso.x, torso.y)
  if (torsoLen < 1) return undefined
  const cosArmTorso =
    (upperArm.x * torso.x + upperArm.y * torso.y) / (upperArmLen * torsoLen)
  const armTorsoDeg = (Math.acos(Math.min(1, Math.max(-1, cosArmTorso))) * 180) / Math.PI
  if (armTorsoDeg < ARM_AWAY_FROM_BODY_MIN_DEG || armTorsoDeg > ARM_AWAY_FROM_BODY_MAX_DEG) {
    return undefined
  }

  return {
    x: elbow.x + (wrist.x - elbow.x) * FOREARM_LAND_RATIO,
    y: elbow.y + (wrist.y - elbow.y) * FOREARM_LAND_RATIO,
    side,
    vis,
  }
}

/** target coords for the bat to land on, assuming a bottom-middle anchor —
 * a point along the forearm (elbow->wrist, MP-33 indices 13/14 and 15/16),
 * short of the wrist so the bat perches on the forearm rather than the hand
 * (see FOREARM_LAND_RATIO), on whichever arm is straight (see
 * ARM_STRAIGHT_MAX_DEVIATION_DEG) and held away from the body at roughly a
 * right angle (see ARM_AWAY_FROM_BODY_MIN_DEG/MAX_DEG) — an arm hanging at
 * the side or raised straight up no longer qualifies. Deliberately not using
 * calculateArmFromPose's elbow+angle+length reconstruction: that angle is
 * computed with Math.atan (not atan2), which can't recover which side of the
 * elbow the wrist is actually on, so it only ever looked right for the owl's
 * halfway-point perch — reaching further toward the wrist regularly landed on
 * the wrong side entirely. This uses plain vector subtraction instead, which
 * has no such sign ambiguity.
 *
 * `lockedSide`, if given, is tried FIRST and used as long as it still
 * qualifies — even if the other arm is now more confidently tracked. Without
 * this, raising both arms (both qualifying) left the choice up to whichever
 * side edged out the other on leftVis/rightVis that particular frame, which
 * flips back and forth from ordinary tracking noise — the bat visibly
 * hopping between arms rather than settling on the one it first landed on.
 * Only falls back to confidence-based picking once the locked side actually
 * stops qualifying (arm lowered, bent, turned away, etc). */
function getForearmTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  lockedSide?: ArmSide,
) {
  if (pose.length === 0) return undefined

  if (lockedSide) {
    const locked = evaluateArm(pose, height, width, lockedSide)
    if (locked) return locked
  }

  // No locked side, or it stopped qualifying — fall back to picking by
  // confidence between whichever arm(s) currently qualify.
  const left = evaluateArm(pose, height, width, 'left')
  const right = evaluateArm(pose, height, width, 'right')
  if (!left && !right) return undefined
  if (!left) return right
  if (!right) return left
  return left.vis >= right.vis ? left : right
}

function calculateBatSize(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!leftEar || !rightEar) return 200
  const x1 = convertPoint(leftEar, height, width).x
  const x2 = convertPoint(rightEar, height, width).x
  return Math.max(150, Math.abs(x2 - x1) * 2.5)
}

export async function createBatAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app
  const batContainer = new PIXI.Container()

  // cloning necessary for reuse since animation itself is a single sprite...
  const [restTexture, flySprite, landSprite, vanishSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, batRestPng).then((res) => res.texture!),
    PIXI.ensureLoaded(loader, batFlyGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batSwoopGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batVanishGif).then((res) => res.animation!.clone()),
  ])

  const restSprite = PIXI.Sprite.from(restTexture)
  restSprite.anchor.set(0.5, 1)
  batContainer.addChild(restSprite)
  // Bat_rest.png is a wide, non-square image (648x396) — forcing it into the
  // same square batSize as the other sprites squashed it visibly. Scale its
  // width off its own natural aspect ratio instead, so it renders undistorted.
  const restAspect = restTexture.width / restTexture.height

  flySprite.anchor.set(0.5, 1)
  batContainer.addChild(flySprite)

  landSprite.anchor.set(0.5, 1)
  batContainer.addChild(landSprite)

  vanishSprite.anchor.set(0.5, 1)
  batContainer.addChild(vanishSprite)

  const initialState = () => {
    batContainer.alpha = 1
    batContainer.position.set(0, 0)
    flySprite.stop()
    landSprite.stop()
    vanishSprite.stop()
    restSprite.alpha = flySprite.alpha = landSprite.alpha = vanishSprite.alpha = 0
    flySprite.currentFrame = landSprite.currentFrame = vanishSprite.currentFrame = 0
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    batSize: new KalmanFilter(KF_PARAMS),
  }

  // NOTE: last fly loop included in landing animation
  /** time in seconds till land animation */
  const toLandTime = (flySprite.duration * ANIM.FLY_LOOPS) / 1000
  /** time in seconds till idle (resting) */
  const toIdleTime = toLandTime + landSprite.duration / 1000
  const vanishDuration = vanishSprite.duration / 1000
  let batSize = 150
  const animManager = new AnimStateManager()

  // Persisted across calls (like drone.ts's wristX/wristY), NOT reset to 0
  // every frame — so a gap covered by the hold timer below leaves the bat
  // right where it was instead of snapping to the corner.
  let wristX = 0
  let wristY = 0
  let holdTimer = 0
  let confirmTimer = 0
  // Which arm the bat is currently committed to, if any — see getForearmTarget's
  // lockedSide param. Reset to undefined once the bat fully exits, so the next
  // spawn picks fresh by confidence rather than favouring whatever arm it used
  // last time.
  let lockedSide: ArmSide | undefined

  const update = (pose: NormalizedLandmarkList) => {
    const target = getForearmTarget(pose, height, width, lockedSide)

    if (target) {
      lockedSide = target.side
      holdTimer = ARM_HOLD_TIME
      confirmTimer = Math.min(ARM_CONFIRM_TIME, confirmTimer + ticker.deltaMS / 1000)
      wristX = kf.x.filter(target.x)
      wristY = kf.y.filter(target.y)
      batSize = kf.batSize.filter(calculateBatSize(pose, height, width))
    } else {
      holdTimer = Math.max(0, holdTimer - ticker.deltaMS / 1000)
      // Reset on any gap — confirmation must be one continuous qualifying
      // stretch, not accumulated flickers, or this stops filtering noise.
      confirmTimer = 0
    }

    const x = wristX
    const y = wristY + batSize * BAT_MARGIN_B

    restSprite.height = batSize * REST_SIZE_FACTOR
    restSprite.width = batSize * REST_SIZE_FACTOR * restAspect

    flySprite.height =
      flySprite.width =
      landSprite.height =
      landSprite.width =
      vanishSprite.height =
      vanishSprite.width =
        batSize

    // Already-tracking: tolerate brief gaps via the hold timer, no need to
    // re-confirm every tiny flicker. Not yet tracking: require the full
    // confirm duration first, so a single stray frame can't trigger it.
    const hasArm = animManager.tracking
      ? target !== undefined || holdTimer > 0
      : confirmTimer >= ARM_CONFIRM_TIME

    animManager.tracking = hasArm
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        lockedSide = undefined
        break
      case 'entering':
        batContainer.alpha = 1
        batContainer.position.set(
          lerpEO(time, 0, toLandTime) * x,
          lerpEO(time, 0, toLandTime) * y,
        )
        switch (true) {
          case time < ANIM.FADE:
            if (!flySprite.playing) flySprite.play()
            flySprite.alpha = lerpLinear(time, 0, ANIM.FADE)
            break
          case toLandTime <= time && time < toIdleTime:
            if (!landSprite.playing) landSprite.play()
            flySprite.alpha = 0
            landSprite.alpha = 1
            break
          case time < toIdleTime:
            break
          default:
            animManager.transition()
        }
        break
      case 'entered':
        batContainer.alpha = restSprite.alpha = 1
        landSprite.alpha = flySprite.alpha = 0
        batContainer.position.set(x, y)
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
        restSprite.alpha = flySprite.alpha = landSprite.alpha = 0
        if (!vanishSprite.playing) vanishSprite.play()
        if (time < vanishDuration) {
          vanishSprite.alpha = 1
          batContainer.alpha = 1 - lerpLinear(time, vanishDuration * 0.5, vanishDuration)
        } else {
          initialState()
          animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [batContainer, update] as const
}
