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
  PERCH_BLEND_S,
  createPerchState,
  perchBob,
  perchSettleProgress,
  perchWingStretch,
  stepPerch,
} from './batPerch'

import batFlyGif from '../assets/Bat_anim/Bat.gif'
import batSwoopGif from '../assets/Bat_anim/bat_swoop.gif'
import batVanishGif from '../assets/Bat_anim/bat_vanish.gif'
import batPerchPng from '../assets/Bat_anim/bat_perch.png'

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
// The perched bat is its own art, bat_perch.png: upright, front-facing, wings
// spread, standing on the arm (see batPerch.ts for why it is not Bat.gif).
// Its anchor is the point between its feet - measured from the image (claws'
// horizontal centre, at their lowest row) - so placing the sprite places the
// feet, and any scaling grows up and out from where they grip the arm.
const PERCH_FEET = { x: 0.4774, y: 0.9862 }
/** bat_perch.png's width / height; sized aspect-correct, unlike the square
 * flight gifs, or it would be squashed. */
const PERCH_ASPECT = 2.4414
/** Perched wingspan, in multiples of batSize. */
const PERCH_WIDTH = 1.1
// How far below the forearm's centre line the feet sit, in multiples of
// batSize. 0 = right on the line the bat targets (batArm.ts); negative lifts
// them onto the top of the arm rather than into the middle of it.
const PERCH_SINK = -0.04
// Breathing on the perch: a vertical squash only, in multiples of scale. The
// sprite itself does not bob - it is anchored at the feet, and moving it would
// lift them off the arm, which is exactly the hovering look this art replaced.
const PERCH_SQUASH_AMP = 0.02
// How far the wings stretch out during a flutter, in multiples of width.
const PERCH_STRETCH_AMP = 0.06
// Scale the perch starts at as it blends in from the swoop, growing to 1.
const PERCH_POP = 0.85
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
  const [flySprite, landSprite, vanishSprite, perchTexture] = await Promise.all([
    PIXI.ensureLoaded(loader, batFlyGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batSwoopGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batVanishGif).then((res) => res.animation!.clone()),
    PIXI.ensureLoaded(loader, batPerchPng).then((res) => res.texture!),
  ])
  // A still image; its motion comes from drawPerch (batPerch.ts timing).
  const perchSprite = PIXI.Sprite.from(perchTexture)

  perchSprite.anchor.set(PERCH_FEET.x, PERCH_FEET.y)
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
    flySprite.currentFrame = landSprite.currentFrame = vanishSprite.currentFrame = 0
  }
  initialState()

  let perch = createPerchState()
  /** Whether the bat is on the perch: set on the first 'entered' frame, which
   * starts a fresh perch, and cleared once the lift-off begins. Tracked
   * explicitly because the perch's alpha ramps in and out, so "alpha is 0"
   * no longer means "not perched yet". */
  let perched = false
  /** The perch's alpha when the lift-off began, faded from there to 0. */
  let perchLeaveAlpha = 0
  /** shows the perched bat for this frame: steps its timing by `dt` seconds
   * and places it on the arm (relative to batContainer, which tracking
   * moves). Over the settle it blends in from the swoop's last frame. */
  const drawPerch = (dt: number) => {
    stepPerch(perch, dt)
    const settle = perchSettleProgress(perch)
    const bob = perchBob(perch)
    const pop = PERCH_POP + (1 - PERCH_POP) * lerpEO(settle, 0, 1)
    const width = batSize * PERCH_WIDTH * pop
    perchSprite.width = width * (1 + PERCH_STRETCH_AMP * perchWingStretch(perch))
    perchSprite.height = (width / PERCH_ASPECT) * (1 + PERCH_SQUASH_AMP * bob)
    // The container sits BAT_MARGIN_B below the forearm target (shared with
    // the flight sprites); cancel that so the anchored feet land on it.
    perchSprite.position.set(0, (-BAT_MARGIN_B + PERCH_SINK) * batSize)
    perchSprite.alpha = settle
    landSprite.alpha = 1 - settle
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

    // (the perch sizes itself, aspect-correct, in drawPerch)
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
        // Here and not in initialState(), which runs during setup before these
        // `let` bindings exist (temporal dead zone - see owl.ts's resetPerch).
        perched = false
        perchLeaveAlpha = 0
        lockedSide = undefined
        break
      case 'entering':
        batContainer.alpha = 1
        // Only non-zero if this is a resume out of 'exiting'.
        vanishSprite.alpha = 0
        // Not perched yet, so a loss from here must not fade a perch out.
        perchSprite.alpha = perchLeaveAlpha = 0
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
        // Not perched means this is the first frame after the swoop, or a
        // resume out of 'exiting' — either way the bat is arriving from the
        // swoop, so start the perch over from its settle, which blends the
        // swoop's frame (held, side-on) into the perched art (front-on).
        if (!perched) {
          perch = createPerchState()
          perched = true
        }
        flySprite.alpha = 0
        // Hold the swoop on its frame for the blend, and undo a lift-off a
        // resume out of 'exiting' interrupted.
        if (landSprite.playing) landSprite.stop()
        drawPerch(ticker.deltaMS / 1000)
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
            if (perched) drawPerch(ticker.deltaMS / 1000)
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
        flySprite.alpha = 0
        // The perch fades out over the start of the lift-off, under the swoop
        // clip, rather than cutting straight from front-on to side-on.
        // Clearing `perched` here is what makes a resume out of 'exiting'
        // blend back in like a fresh landing.
        if (perched) {
          perched = false
          perchLeaveAlpha = perchSprite.alpha
        }
        perchSprite.alpha = perchLeaveAlpha * (1 - lerpLinear(time, 0, PERCH_BLEND_S))
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
