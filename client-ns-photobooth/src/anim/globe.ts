import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import { getAnimScale } from '../store'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { AnimStateManager } from './AnimState'
import { createArmDebugLogger, f2 } from './armDebug'
import {
  TorsoAnchor,
  checkHandsHold,
  createLatch,
  getTorsoAnchor,
  resetLatch,
  stepLatch,
} from './globePose'

import globeGif from '../assets/globe_anim/globe.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }
const HAND_KF_PARAMS = { R: 0.02, Q: 3 }
const ORBIT_SPEED = 0.8
const ORBIT_RADIUS_FACTOR = 0.9
const ORBIT_Y_SQUISH = 0.5

// The orbit runs as a full circle now, read as an ellipse tilted away from
// the camera. sin(angle) is the depth cue and drives everything below: +1 at
// the near point (lowest on screen, sweeping in front of the body), -1 at
// the far point (highest on screen, passing behind it).
//
// How much the globe grows toward the camera and shrinks away from it, as a
// fraction of its base size. This perspective change is what sells the path
// as a loop through depth rather than a flat arc across the body.
const DEPTH_SCALE = 0.25

// Depth at which the globe has faded out completely. It starts fading as it
// crosses the side of the body (depth 0), is fully gone by this much depth,
// and stays gone across the deepest part of the pass before easing back in
// on the other side.
//
// There's no person-segmentation mask in this pipeline, so "behind the body"
// has to be sold with opacity rather than real occlusion. This replaced a
// hard cut at a fixed angle followed by a timed absence, which read as the
// globe blinking out rather than travelling anywhere. At the default orbit
// speed the globe is fully hidden for roughly 2.5s with about 0.7s of fade
// at each end — raise this to shorten the hidden stretch and lengthen the
// fades, lower it for the reverse.
const BEHIND_FADE_DEPTH = 0.55
const BOB_SPEED = 2.5
const BOB_AMPLITUDE = 0.08

// Between-hands mode: the globe leaves its orbit for the midpoint of the
// person's hands while they hold them apart at chest height (the gate itself
// is checkHandsHold in globePose.ts). It used to switch on and off on single
// frames, with nothing smoothing the change - see GLOBE_GATES for why that
// put it on people's groins. Now:
//
// - the pose has to hold for HANDS_CONFIRM_S before the globe goes to the
//   hands, and be gone for HANDS_HOLD_S before it leaves them. 0.2s is two
//   detections on the ~10Hz webcam path; 0.45s rides out two dropped ones
//   even on a ~5fps capture card.
// - position, size and opacity blend between orbit and hands over
//   HANDS_BLEND_S rather than jumping in one frame.
const HANDS_CONFIRM_S = 0.2
const HANDS_HOLD_S = 0.45
const HANDS_BLEND_S = 0.3
/** held globe size, as a fraction of the distance between the hands */
const HANDS_SIZE_FACTOR = 0.4

// A torso measurement this far (in multiples of the globe's size) from where
// the filtered torso sits is not trusted straight away: it has to persist for
// TORSO_JUMP_CONFIRM_S first, and is then snapped to by re-seeding the
// filters, instead of the globe being dragged across the frame. Covers
// one-frame keypoint glitches, the backend swapping between ViTPose and YOLO
// keypoints, and single-target mode handing the globe to a different person.
const TORSO_JUMP_FACTOR = 1.0
const TORSO_JUMP_CONFIRM_S = 0.15

interface FeedBounds { left: number; right: number; top: number; bottom: number }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (t: number) => t * t * (3 - 2 * t)

function calculateGlobeSize(shoulderWidth: number) {
  return Math.max(100, shoulderWidth * 0.7)
}

// ---------------------------------------------------------------------------
// Globe animation
// ---------------------------------------------------------------------------

export async function createGlobeAnim(
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
  const sprite = await PIXI.ensureLoaded(loader, globeGif).then((r) => r.animation!.clone())
  sprite.anchor.set(0.5, 0.5)
  container.addChild(sprite)

  const initialState = () => {
    container.alpha = 0
    container.position.set(0, 0)
    sprite.stop()
    sprite.alpha = 0
    sprite.currentFrame = 0
  }
  initialState()

  // Replaced wholesale (rather than reset - kalmanjs has no reset) whenever
  // they need to start over from the next measurement: see seedTorso and
  // the hands latch below.
  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    handX: new KalmanFilter(HAND_KF_PARAMS),
    handY: new KalmanFilter(HAND_KF_PARAMS),
    handSize: new KalmanFilter(HAND_KF_PARAMS),
  }
  const seedTorso = () => {
    kf.x = new KalmanFilter(KF_PARAMS)
    kf.y = new KalmanFilter(KF_PARAMS)
    kf.size = new KalmanFilter(KF_PARAMS)
  }
  const seedHands = () => {
    kf.handX = new KalmanFilter(HAND_KF_PARAMS)
    kf.handY = new KalmanFilter(HAND_KF_PARAMS)
    kf.handSize = new KalmanFilter(HAND_KF_PARAMS)
  }

  let globeSize = 150
  let orbitAngle = 0
  let bobTime = 0
  let torsoX = 0
  let torsoY = 0
  /** whether torsoX/torsoY describe anyone yet - false until the first
   * measurement after a full exit, which seeds fresh filters rather than
   * sliding over from whoever this instance (or its slot) followed before */
  let haveTorso = false
  /** how long a too-far torso measurement has persisted - see TORSO_JUMP_* */
  let jumpTimer = 0

  const handsLatch = createLatch()
  /** 0 = orbiting, 1 = held between the hands; eased with smoothstep */
  let handsBlend = 0
  let handX = 0
  let handY = 0
  let handSize = 150

  const animManager = new AnimStateManager()
  const debugLog = createArmDebugLogger('globe')

  const advanceOrbit = (dt: number) => {
    orbitAngle = (orbitAngle + dt * ORBIT_SPEED) % (Math.PI * 2)
  }

  /** Where the globe sits, how big it is and how solid it looks at the
   * current orbit angle. */
  const orbitFrame = (bobOffset: number) => {
    const depth = Math.sin(orbitAngle)
    const size = globeSize * (1 + DEPTH_SCALE * depth)
    const orbitR = globeSize * ORBIT_RADIUS_FACTOR
    const p = clampPos(
      torsoX + Math.cos(orbitAngle) * orbitR,
      torsoY + depth * orbitR * ORBIT_Y_SQUISH + bobOffset,
      size, bounds,
    )
    // Smoothstep over the clamped ramp: a bare linear fade leaves a visible
    // corner where it meets full opacity and full transparency, which is the
    // same kind of abruptness this is meant to get rid of.
    const t = lerpLinear(depth, -BEHIND_FADE_DEPTH, 0)
    return { x: p.x, y: p.y, size, alpha: smoothstep(t) }
  }

  /** The orbit frame blended toward the held-between-hands frame by
   * handsBlend. Shared by 'entered' and 'lost' so the two can't drift apart. */
  const globeFrame = (bobOffset: number) => {
    const o = orbitFrame(bobOffset)
    const b = smoothstep(handsBlend)
    if (b <= 0) return o
    const hp = clampPos(handX, handY + bobOffset, handSize, bounds)
    return {
      x: lerp(o.x, hp.x, b),
      y: lerp(o.y, hp.y, b),
      size: lerp(o.size, handSize, b),
      alpha: lerp(o.alpha, 1, b),
    }
  }

  const drawGlobe = (dt: number) => {
    // Frozen while fully held, so letting go resumes the orbit where it left.
    if (handsBlend < 1) advanceOrbit(dt)
    bobTime += dt
    const bobOffset = Math.sin(bobTime * BOB_SPEED) * globeSize * BOB_AMPLITUDE
    const f = globeFrame(bobOffset)
    sprite.height = sprite.width = f.size
    sprite.alpha = f.alpha
    container.position.set(f.x, f.y)
  }

  const update = (pose: NormalizedLandmarkList) => {
    const dt = ticker.deltaMS / 1000

    // --- torso ---------------------------------------------------------
    const torsoCheck = getTorsoAnchor(pose, height, width, animManager.tracking)
    let torso: TorsoAnchor | undefined = torsoCheck.ok ? torsoCheck.torso : undefined
    let torsoReason = torsoCheck.ok ? 'ok' : torsoCheck.reason
    // Present but not yet trusted: the person is still there, so the
    // animation keeps tracking, but this frame doesn't move the globe.
    let jumpPending = false

    if (torso && haveTorso) {
      const jump = Math.hypot(torso.x - torsoX, torso.y - torsoY)
      if (jump > globeSize * TORSO_JUMP_FACTOR) {
        jumpTimer += dt
        if (jumpTimer >= TORSO_JUMP_CONFIRM_S) {
          // It stuck - snap to it rather than glide across the frame.
          seedTorso()
          jumpTimer = 0
          torsoReason = 'jumped'
        } else {
          jumpPending = true
          torsoReason = `jump=${(jump / globeSize).toFixed(1)}`
        }
      } else {
        jumpTimer = 0
      }
    }
    if (torso && !haveTorso) seedTorso()

    if (torso && !jumpPending) {
      haveTorso = true
      torsoX = kf.x.filter(torso.x)
      torsoY = kf.y.filter(torso.y)
      globeSize =
        kf.size.filter(calculateGlobeSize(torso.shoulderWidth)) *
        getAnimScale('globe')
    }

    sprite.height = sprite.width = globeSize

    animManager.tracking = !!torso
    const { time, state } = animManager

    // --- hands -----------------------------------------------------------
    // Only judged against a torso this frame actually trusts, and only once
    // the globe has arrived ('entered'). Anywhere else - including 'lost' -
    // counts as not holding, so the hold timer lets go and the blend runs
    // the globe back out to its orbit.
    const handsCheck =
      torso && !jumpPending && state === 'entered'
        ? checkHandsHold(pose, height, width, torso, handsLatch.on)
        : undefined
    const wasHeld = handsLatch.on
    const held = stepLatch(handsLatch, !!handsCheck?.ok, dt, {
      confirmS: HANDS_CONFIRM_S,
      holdS: HANDS_HOLD_S,
    })
    // Fresh filters on every new hold: the old ones were only fed while
    // holding, so on the next hold they started wherever the hands were
    // LAST time and the globe flew in from there.
    if (held && !wasHeld) seedHands()
    if (held && handsCheck?.ok) {
      handX = kf.handX.filter(handsCheck.x)
      handY = kf.handY.filter(handsCheck.y)
      handSize = kf.handSize.filter(handsCheck.distance * HANDS_SIZE_FACTOR)
    }
    handsBlend = Math.max(0, Math.min(1,
      handsBlend + (held ? dt : -dt) / HANDS_BLEND_S,
    ))

    // left/right carry the torso and hands gates here, not two arms.
    debugLog({
      state,
      locked: held ? 'hands' : undefined,
      left: `torso:${torsoReason}`,
      right: `hands:${handsCheck ? (handsCheck.ok ? 'ok' : handsCheck.reason) : '-'}`,
      timers:
        `confirm=${f2(handsLatch.confirm)} hold=${f2(handsLatch.hold)} ` +
        `blend=${f2(handsBlend)} jump=${f2(jumpTimer)} t=${f2(time)}`,
    })

    switch (state) {
      case 'exited':
        initialState()
        orbitAngle = 0
        bobTime = 0
        haveTorso = false
        jumpTimer = 0
        resetLatch(handsLatch)
        handsBlend = 0
        break

      case 'entering': {
        container.alpha = 1
        if (!sprite.playing) sprite.play()
        sprite.alpha = lerpLinear(time, 0, ANIM.FADE)

        const progress = lerpEO(time, 0, ANIM.FADE)
        const startX = torsoX + width * 0.3
        const startY = torsoY - height * 0.2
        const ep = clampPos(
          startX + (torsoX - startX) * progress,
          startY + (torsoY - startY) * progress,
          globeSize, bounds,
        )
        container.position.set(ep.x, ep.y)

        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered':
        if (!sprite.playing) sprite.play()
        container.alpha = 1
        drawGlobe(dt)
        break

      case 'lost':
        drawGlobe(dt)
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

    animManager.update(dt)
  }

  return [container, update] as const
}
