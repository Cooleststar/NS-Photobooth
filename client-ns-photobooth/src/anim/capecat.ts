import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'
import { BatArmSide as ArmSide, CAPECAT_ARM_GATES, getForearmTarget } from './batArm'
import { createArmDebugLogger, f2 } from './armDebug'
// The globe's confirm/hold debounce - pure and already tested.
import { createLatch, stepLatch } from './globePose'
import { runFrame } from './capecatRun'
import { freezePosition, getAnimScale } from '../store'

// The caped cat was the bat's resting pose until the bat got perch art of its
// own (b1d0d62). It is its own character now: raise an arm the way the bat
// wants it - straight, held away from the body - and the cat runs in from the
// top-left corner and stands on the forearm near the hand.
import catGif from '../assets/Bat_anim/Bat_rest2.gif'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

// R is system noisiness, Q is measurement noisiness
const KF_PARAMS = { R: 0.03, Q: 2 }

/** Bat_rest2.gif's anchor: between its feet, measured from the art (the
 * horizontal centre of the opaque pixels across the bottom rows, the lowest
 * opaque row). The art is not centred - the cape and tail trail off to the
 * right - so a centred anchor would stand the cat beside the arm. */
const CAT_FEET = { x: 0.39, y: 0.99 }

/** Debounce on the arm gate: the arm must qualify this long before the cat
 * sets off, and may drop out this long without the cat giving up. Confirm is
 * shorter than the bat's 0.15s to make the cat easier to summon. */
const ARM_CONFIRM_SEC = 0.1
const ARM_HOLD_SEC = 0.4

/** How long the run in from the corner takes. */
const RUN_SEC = 1.2
/** How long the run back off to the corner takes when it leaves. */
const LEAVE_SEC = 0.9
/** Gif speed while running - the idle loop's flutter, doubled, reads as
 * effort; there is no running clip. */
const RUN_GIF_SPEED = 2
/** The squash it settles with on arrival, which also hides the turn from
 * facing its run direction back to its resting direction. */
const ARRIVE_SEC = 0.2
const ARRIVE_SQUASH = 0.15
/** How fast a cat called back mid-leave catches up with the arm, per second
 * (fraction of the remaining gap). */
const RETURN_RATE = 8
/** How fast a cat that loses the arm mid-run drops out of its hop, per second
 * (fraction of the remaining height). */
const LAND_RATE = 12

function calculateCatSize(pose: NormalizedLandmarkList, height: number, width: number) {
  // Same basis as the bat (bat.ts's calculateBatSize): scales with how close
  // the person is.
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!leftEar || !rightEar) return 200
  const x1 = convertPoint(leftEar, height, width).x
  const x2 = convertPoint(rightEar, height, width).x
  return Math.max(150, Math.abs(x2 - x1) * 2.5)
}

export async function createCapeCatAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()
  const sprite = await PIXI.ensureLoaded(loader, catGif).then((r) => r.animation!.clone())
  sprite.anchor.set(CAT_FEET.x, CAT_FEET.y)
  container.addChild(sprite)
  const texW = sprite.texture.width
  const texH = sprite.texture.height

  const initialState = () => {
    container.alpha = 1
    container.position.set(0, 0)
    sprite.stop()
    sprite.alpha = 0
    sprite.currentFrame = 0
    sprite.position.set(0, 0)
  }
  initialState()

  const kf = {
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
  }

  let targetX = 0
  let targetY = 0
  let catSize = 150
  let lockedSide: ArmSide | undefined
  const arm = createLatch()
  /** time since arriving on the arm, for the arrival squash */
  let arrivedFor = Infinity
  /** where the run-off started, and how visible the cat was then - captured
   * on the first 'exiting' frame */
  let leaveFrom: { x: number; y: number } | undefined
  let leaveAlpha = 1
  /** called back to the arm while running off - ease there, don't snap */
  let returning = false
  /** where the current run in started, and how far into it the cat is. Its
   * own clock rather than animManager.time, so a run picked up again after a
   * loss can start over from where the cat stopped. */
  let runFrom = { x: 0, y: 0 }
  let runT = 0
  /** set by 'lost'/'exiting': the next 'entering'/'entered' frame is a resume
   * and must carry on from where the cat is now, not where it was */
  let interrupted = false
  /** what drawSprite last drew, so 'lost' can bring a cat down from mid-hop */
  let facing: 1 | -1 = -1
  let drawnSquash = 0
  let drawnHop = 0

  /** Size, facing (1 = the art's own leftward facing, -1 = flipped to face
   * right) and squash, all through the sprite's scale. */
  const drawSprite = (face: 1 | -1, squash: number, hopPx: number) => {
    facing = face
    drawnSquash = squash
    drawnHop = hopPx
    const base = catSize / Math.max(texW, texH)
    sprite.scale.set(base * face * (1 + squash * 0.5), base * (1 - squash))
    sprite.position.set(0, -hopPx)
  }

  /** Facing for travelling `dx` px sideways; keeps the current facing when
   * the run is (near enough) straight down, rather than flickering. */
  const faceFor = (dx: number): 1 | -1 => (dx > 1 ? -1 : dx < -1 ? 1 : facing)

  /** Brings a faded-out cat back up, rather than popping it to full alpha
   * when it is called back mid run-off. */
  const fadeContainerIn = (dt: number) => {
    container.alpha = ANIM.FADE > 0 ? Math.min(1, container.alpha + dt / ANIM.FADE) : 1
  }

  // resumeFromExit: an arm raised again while the cat is running off calls it
  // back, rather than the run-off finishing and a new cat starting over from
  // the corner. 'entered' below restores what 'exiting' changes.
  const animManager = new AnimStateManager({ resumeFromExit: true })
  const debugLog = createArmDebugLogger('capecat')

  const update = (pose: NormalizedLandmarkList) => {
    const dt = ticker.deltaMS / 1000
    const diag: Partial<Record<ArmSide, string>> = {}
    const target = getForearmTarget(pose, height, width, lockedSide, diag, CAPECAT_ARM_GATES)

    if (target) {
      lockedSide = target.side
      targetX = kf.x.filter(target.x)
      targetY = kf.y.filter(target.y)
      catSize = kf.size.filter(calculateCatSize(pose, height, width)) * getAnimScale('capecat')
    }
    const hasArm = stepLatch(arm, !!target, dt, {
      confirmS: ARM_CONFIRM_SEC,
      holdS: ARM_HOLD_SEC,
    })

    animManager.tracking = hasArm
    const { time, state } = animManager

    debugLog({
      state,
      locked: lockedSide,
      left: diag.left,
      right: diag.right,
      timers: `confirm=${f2(arm.confirm)} hold=${f2(arm.hold)} t=${f2(time)}`,
    })

    switch (state) {
      case 'exited':
        initialState()
        // Here and not in initialState(), which runs during setup before these
        // `let` bindings exist (temporal dead zone - see owl.ts's resetPerch).
        // Not resetLatch(arm): 'exited' is also where the cat waits for the
        // latch to confirm, so resetting it here every frame wiped the
        // confirm timer each tick and the cat could never set off. The latch
        // is already off by the time a run-off ends, so nothing to reset.
        // Likewise the arm lock is only dropped once no arm qualifies, so
        // it doesn't hop sides each frame while confirming.
        if (!target) lockedSide = undefined
        arrivedFor = Infinity
        leaveFrom = undefined
        leaveAlpha = 1
        returning = false
        runFrom = { x: 0, y: 0 }
        runT = 0
        interrupted = false
        facing = -1
        break

      case 'entering': {
        // Runs in from the canvas's top-left corner. Its anchor is its feet,
        // so at (0,0) the cat is still above the top edge - it appears running
        // in, rather than popping into existence in the corner.
        if (interrupted) {
          // Picked up again after a loss, or called back mid run-off: run on
          // from wherever the cat stopped instead of jumping back onto the
          // old path (and hanging on to a stale run-off start).
          interrupted = false
          leaveFrom = undefined
          runFrom = { x: container.x, y: container.y }
          runT = 0
        }
        fadeContainerIn(dt)
        if (!sprite.playing) sprite.play()
        sprite.animationSpeed = RUN_GIF_SPEED
        // max: a cat called back mid run-off is already showing.
        sprite.alpha = Math.max(sprite.alpha, lerpLinear(runT, 0, ANIM.FADE))
        const f = runFrame(runT, RUN_SEC)
        container.position.set(
          runFrom.x + (targetX - runFrom.x) * f.progress,
          runFrom.y + (targetY - runFrom.y) * f.progress,
        )
        // The art faces left; face it the way it is running (rightwards from
        // the corner, but a resumed run can head either way).
        drawSprite(faceFor(targetX - runFrom.x), f.squash, f.hop * catSize)
        if (runT >= RUN_SEC) {
          arrivedFor = 0
          animManager.transition()
        }
        runT += dt
        break
      }

      case 'entered': {
        fadeContainerIn(dt)
        sprite.alpha = 1
        if (!sprite.playing) sprite.play()
        arrivedFor += dt
        if (interrupted) {
          // Back after a loss or called back mid run-off (resumeFromExit): the
          // arm may have moved meanwhile, so ease back from wherever the cat
          // is instead of snapping onto it.
          interrupted = false
          leaveFrom = undefined
          returning = true
        }
        const frozen = freezePosition.get()
        let runFace = facing
        if (!frozen) {
          if (returning) {
            const k = Math.min(1, dt * RETURN_RATE)
            const dx = targetX - container.x
            const nx = container.x + dx * k
            const ny = container.y + (targetY - container.y) * k
            container.position.set(nx, ny)
            runFace = faceFor(dx)
            if (Math.hypot(targetX - nx, targetY - ny) < 2) {
              returning = false
              // Ran back rightwards: settle and turn back to rest like a
              // fresh arrival, instead of flipping on the spot.
              if (runFace === -1) arrivedFor = 0
            }
          } else {
            container.position.set(targetX, targetY)
          }
        }
        if (returning && !frozen) {
          sprite.animationSpeed = RUN_GIF_SPEED
          drawSprite(runFace, 0, 0)
          break
        }
        sprite.animationSpeed = 1
        // Settles with a squash, and turns back to its resting (leftward)
        // facing at the bottom of it, where the flip is hardest to see.
        const settle = arrivedFor < ARRIVE_SEC
          ? ARRIVE_SQUASH * Math.sin(Math.PI * (arrivedFor / ARRIVE_SEC))
          : 0
        drawSprite(arrivedFor < ARRIVE_SEC / 2 ? -1 : 1, settle, 0)
        break
      }

      case 'lost': {
        // Waits where it is for the arm to come back - but on the ground and
        // at its idle pace, not frozen mid-hop with the run's legs going.
        interrupted = true
        sprite.animationSpeed = 1
        const k = Math.min(1, dt * LAND_RATE)
        drawSprite(facing, drawnSquash * (1 - k), drawnHop * (1 - k))
        if (time >= ANIM.RETRACK) animManager.transition()
        break
      }

      case 'exiting': {
        // Runs back off to the top-left corner it came from, fading as it
        // goes - the same hops in reverse, facing its own (leftward) way.
        if (!leaveFrom) {
          leaveFrom = { x: container.x, y: container.y }
          leaveAlpha = container.alpha
        }
        interrupted = true
        if (!sprite.playing) sprite.play()
        sprite.animationSpeed = RUN_GIF_SPEED
        const f = runFrame(time, LEAVE_SEC)
        container.position.set(
          leaveFrom.x * (1 - f.progress),
          leaveFrom.y * (1 - f.progress),
        )
        drawSprite(1, f.squash, f.hop * catSize)
        // From whatever alpha it had: a cat that was still fading back in
        // must not pop to full before fading out.
        container.alpha = leaveAlpha * (1 - lerpLinear(time, LEAVE_SEC * 0.4, LEAVE_SEC))
        if (time >= LEAVE_SEC) {
          initialState()
          leaveFrom = undefined
          animManager.transition()
        }
        break
      }
    }

    animManager.update(dt)
  }

  return [container, update] as const
}
