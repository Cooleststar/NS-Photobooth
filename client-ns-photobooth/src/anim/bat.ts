import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import { getAnimScale } from '../store'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'
import { BatArmSide as ArmSide, getForearmTarget } from './batArm'
import { createArmDebugLogger, f2 } from './armDebug'
import {
  createPerchState,
  perchBob,
  perchSettleProgress,
  stepPerch,
} from './batPerch'

import batFlyGif from '../assets/Bat_anim/Bat.gif'
import batSwoopGif from '../assets/Bat_anim/bat_swoop.gif'
import batVanishGif from '../assets/Bat_anim/bat_vanish.gif'

/** anim duration & timing config */
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
  FLY_LOOPS: 2,
}

// R is system noisiness, Q is measurement noisiness
const KF_PARAMS = { R: 0.03, Q: 2 }

// Vertical offset (bottom-anchored) below the forearm landing point, in
// multiples of batSize. Was 0.27, lowered on request so the bat reads as
// standing/perched on the arm rather than hanging below it.
const BAT_MARGIN_B = 0.12
// The perched bat (see batPerch.ts) is drawn from Bat.gif, at the same size
// and bottom-middle anchor as the fly/swoop/vanish sprites so the swoop hands
// over to it without a jump. Within Bat.gif's 300x300 frames, though, the
// bat's body sits right of centre and well above the bottom edge (its feet at
// about (0.63, 0.66) of the frame, measured from the brown body pixels, which
// stay within ~10px across all frames), so during the settle the sprite is
// eased by this much to put the feet on the forearm, the wings draping over it.
const PERCH_FEET = { x: 0.63, y: 0.66 }
// How far below the forearm's centre line the feet sit, in multiples of
// batSize. 0 = right on the line the bat targets (batArm.ts).
const PERCH_SINK = 0
// Breathing on the perch, in multiples of batSize (bob) and of scale (squash).
const PERCH_BOB_AMP = 0.015
const PERCH_SQUASH_AMP = 0.02
// Which arms qualify, and where on them the bat lands, live in batArm.ts.

// Debounce for the raw per-frame arm qualification, same pattern as
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
  const [flySprite, landSprite, vanishSprite] = await Promise.all([
    PIXI.ensureLoaded(loader, batFlyGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batSwoopGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batVanishGif).then((res) => res.animation!.clone()),
  ])
  // The perched bat is another copy of the fly animation, never play()ed:
  // update() picks its frame by hand (batPerch.ts), on the same ticker
  // deltaMS as everything else here, so it restarts cleanly with each landing.
  const perchSprite = flySprite.clone()
  perchSprite.autoUpdate = false

  perchSprite.anchor.set(0.5, 1)
  batContainer.addChild(perchSprite)

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
    perchSprite.alpha = flySprite.alpha = landSprite.alpha = vanishSprite.alpha = 0
    perchSprite.currentFrame = flySprite.currentFrame = landSprite.currentFrame = vanishSprite.currentFrame = 0
    perchSprite.position.set(0, 0)
  }
  initialState()

  let perch = createPerchState()
  /** shows the perched bat for this frame: steps its idle by `dt` seconds and
   * places it on the arm (relative to batContainer, which tracking moves). */
  const drawPerch = (dt: number) => {
    const frame = stepPerch(perch, dt)
    // AnimatedGIF redraws its texture on every frame change, so skip no-ops.
    if (perchSprite.currentFrame !== frame) perchSprite.currentFrame = frame
    const settle = perchSettleProgress(perch)
    const bob = perchBob(perch)
    perchSprite.position.set(
      -(PERCH_FEET.x - 0.5) * batSize * settle,
      ((1 - PERCH_FEET.y - BAT_MARGIN_B + PERCH_SINK) * settle + PERCH_BOB_AMP * bob) * batSize,
    )
    // width/height were just set to batSize by update(); squash on top of it.
    perchSprite.scale.y *= 1 + PERCH_SQUASH_AMP * bob
  }

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
  // Landing plays fly -> swoop (a transformation-style clip) -> rest. On
  // request, lifting off mirrors that: rest -> swoop (the SAME clip, reused
  // as a generic "transforming" bridge rather than a landing-specific one)
  // -> vanish, instead of cutting straight from the resting pose to vanish.
  const liftOffDuration = landSprite.duration / 1000
  let batSize = 150
  // resumeFromExit: an arm that requalifies during the (long) lift-off and
  // vanish sequence brings the bat back to its perch, instead of the vanish
  // finishing and a new bat flying in from the corner. 'entering' and
  // 'entered' below restore every sprite 'exiting' hides or starts.
  const animManager = new AnimStateManager({ resumeFromExit: true })
  const debugLog = createArmDebugLogger('bat')

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
    const diag: Partial<Record<ArmSide, string>> = {}
    const target = getForearmTarget(pose, height, width, lockedSide, diag)

    if (target) {
      lockedSide = target.side
      holdTimer = ARM_HOLD_TIME
      confirmTimer = Math.min(ARM_CONFIRM_TIME, confirmTimer + ticker.deltaMS / 1000)
      wristX = kf.x.filter(target.x)
      wristY = kf.y.filter(target.y)
      batSize =
        kf.batSize.filter(calculateBatSize(pose, height, width)) *
        getAnimScale('bat')
    } else {
      holdTimer = Math.max(0, holdTimer - ticker.deltaMS / 1000)
      // Reset on any gap — confirmation must be one continuous qualifying
      // stretch, not accumulated flickers, or this stops filtering noise.
      confirmTimer = 0
    }

    const x = wristX
    const y = wristY + batSize * BAT_MARGIN_B

    perchSprite.height =
      perchSprite.width =
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

    debugLog({
      state,
      locked: lockedSide,
      left: diag.left,
      right: diag.right,
      timers: `hold=${f2(holdTimer)} confirm=${f2(confirmTimer)} t=${f2(time)}`,
    })

    switch (state) {
      case 'exited':
        initialState()
        lockedSide = undefined
        break
      case 'entering':
        batContainer.alpha = 1
        // Only non-zero if this is a resume out of 'exiting'.
        vanishSprite.alpha = 0
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
            // Mid-flight. Normally a no-op (the fade above already left the
            // fly sprite showing), but a resume out of 'exiting' arrives here
            // with it hidden and the swoop showing instead.
            if (!flySprite.playing) flySprite.play()
            flySprite.alpha = 1
            landSprite.alpha = 0
            break
          default:
            animManager.transition()
        }
        break
      case 'entered':
        batContainer.alpha = 1
        // Hidden means this is the first frame after the swoop, or a resume
        // out of 'exiting' — either way the bat is arriving from the swoop's
        // last (wings-up) pose, so start the perch over from its settle.
        if (perchSprite.alpha === 0) perch = createPerchState()
        perchSprite.alpha = 1
        drawPerch(ticker.deltaMS / 1000)
        landSprite.alpha = flySprite.alpha = 0
        // Undo a lift-off/vanish that a resume out of 'exiting' interrupted.
        if (landSprite.playing) landSprite.stop()
        if (vanishSprite.playing || vanishSprite.alpha !== 0) {
          vanishSprite.stop()
          vanishSprite.currentFrame = 0
          vanishSprite.alpha = 0
        }
        batContainer.position.set(x, y)
        break
      case 'lost':
        switch (true) {
          case time < ANIM.RETRACK:
            // Keep a perched bat alive while waiting for the arm to return.
            if (perchSprite.alpha !== 0) drawPerch(ticker.deltaMS / 1000)
            break
          default:
            // landSprite already played through once during entering and is
            // sitting on its last frame — reset it here, the single place
            // that leads into 'exiting', so the lift-off phase below plays
            // it from the start rather than a single frozen frame.
            landSprite.stop()
            landSprite.currentFrame = 0
            animManager.transition()
        }
        break
      case 'exiting':
        perchSprite.alpha = flySprite.alpha = 0
        switch (true) {
          case time < liftOffDuration:
            // Mirrors the landing sequence's swoop phase — same clip reused
            // as a "transforming" bridge out of the resting pose, rather
            // than cutting straight from rest to vanish.
            if (!landSprite.playing) landSprite.play()
            landSprite.alpha = 1
            vanishSprite.alpha = 0
            batContainer.alpha = 1
            break
          case time < liftOffDuration + vanishDuration: {
            landSprite.alpha = 0
            if (!vanishSprite.playing) vanishSprite.play()
            vanishSprite.alpha = 1
            const vanishTime = time - liftOffDuration
            batContainer.alpha = 1 - lerpLinear(vanishTime, vanishDuration * 0.5, vanishDuration)
            break
          }
          default:
            initialState()
            animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [batContainer, update] as const
}
