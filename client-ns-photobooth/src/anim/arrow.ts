import * as PIXI from '../pixi'
import { NormalizedLandmarkList } from '../api/landmarks'

import { lerpLinear } from './utils'
import { AnimStateManager } from './AnimState'
import { convertPoint } from '../api/nicepipe/mpPose'
import arrowImg from '../assets/arrow-down.png'

/** Points out whoever the animations are currently tracking.
 *
 * Rewritten because the original was the only animation in here with no
 * lifecycle at all: it set alpha straight to 0 or 1 every frame, took the
 * nose and the shoulders without once checking whether the pose model was
 * confident about them, and measured size from the HORIZONTAL shoulder gap
 * alone. Each of those has a specific failure, and together they are why it
 * flickered and wandered:
 *
 *   * no hold timer, so a single dropped detection blinked it out entirely
 *     rather than riding out the gap like every other character does
 *   * no visibility gate, so an occluded nose - which the pose models still
 *     predict a position for, confidently or not - threw it across the frame
 *   * |x11 - x12| collapses toward zero as someone turns side-on, so the
 *     arrow shrank to nothing exactly when a person turned to face someone
 *   * Q: 5 on the filter, against 1.5-2 everywhere else, which is a large
 *     part of why it looked jittery even when tracking was good
 *   * nothing clamped it to the frame, so it slid off the top of the screen
 *     for anyone standing close to the camera
 *
 * The artwork is unchanged; this is all behaviour.
 */

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
}

// Was Q: 5. The arrow tracks a head, which moves slowly and smoothly, so it
// wants the steady end of the range rather than the responsive one.
const KF_PARAMS = { R: 0.02, Q: 1.5 }

// MP-33 landmarks.
const NOSE = 0
const LEFT_EAR = 7
const RIGHT_EAR = 8
const LEFT_SHOULDER = 11
const RIGHT_SHOULDER = 12

/** Below this the pose model is guessing, and a guessed nose is what used to
 * fling the arrow across the frame. Same threshold the face props use. */
const MIN_VISIBILITY = 0.5

/** How long the arrow survives losing the pose, so a dropped frame reads as
 * nothing at all rather than a blink. Same idea as the hold timers in
 * drone.ts and boxglove.ts. */
const HOLD_TIME = 0.4

/** Arrow height as a multiple of shoulder width - so it scales with how close
 * the person is, like every other character. */
const SIZE_FACTOR = 0.55
/** Never smaller than this fraction of the canvas height, so someone at the
 * back of the room still gets a visible marker. */
const MIN_SIZE_FACTOR = 0.06

/** Gap between the arrow's tip and the top of the head, in head widths. */
const HEAD_CLEARANCE = 0.35

const BOB_SPEED = 2.2
const BOB_AMPLITUDE_FACTOR = 0.012

/** Framerate-independent easing, as used by the hand characters. */
const FOLLOW_RATE = 12

interface Target {
  x: number
  /** Top of the head, in canvas pixels. */
  headTop: number
  size: number
}

/** Where the arrow should sit, or undefined when the pose can't support it.
 *
 * Deliberately returns undefined rather than a best guess: the arrow says
 * "this person", so pointing confidently at the wrong place is worse than
 * not pointing at all. */
function getTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
): Target | undefined {
  if (pose.length === 0) return undefined
  const nose = pose[NOSE]
  const ls = pose[LEFT_SHOULDER]
  const rs = pose[RIGHT_SHOULDER]
  if (!nose || !ls || !rs) return undefined
  if ((nose.visibility ?? 1) < MIN_VISIBILITY) return undefined
  // Both shoulders, because one alone gives no scale at all.
  if ((ls.visibility ?? 1) < MIN_VISIBILITY || (rs.visibility ?? 1) < MIN_VISIBILITY) {
    return undefined
  }

  const n = convertPoint(nose, height, width)
  const l = convertPoint(ls, height, width)
  const r = convertPoint(rs, height, width)

  // The FULL distance, not just the horizontal part. Someone turning side-on
  // barely changes their real shoulder width, but the horizontal projection
  // of it collapses - which is what shrank the arrow away mid-turn.
  const shoulderWidth = Math.hypot(l.x - r.x, l.y - r.y)
  if (shoulderWidth < 1) return undefined

  // Head size from the ears when they're trustworthy, since that measures the
  // head itself; shoulders are the fallback, at roughly the ratio a head
  // bears to them.
  const le = pose[LEFT_EAR]
  const re = pose[RIGHT_EAR]
  const earsOk =
    le && re && (le.visibility ?? 1) >= MIN_VISIBILITY && (re.visibility ?? 1) >= MIN_VISIBILITY
  let headWidth = shoulderWidth * 0.45
  if (earsOk) {
    const lp = convertPoint(le!, height, width)
    const rp = convertPoint(re!, height, width)
    const span = Math.hypot(lp.x - rp.x, lp.y - rp.y)
    if (span > 1) headWidth = span
  }

  return {
    x: n.x,
    // The nose sits below the crown by roughly a head's width.
    headTop: n.y - headWidth,
    size: Math.max(shoulderWidth * SIZE_FACTOR, height * MIN_SIZE_FACTOR),
  }
}

/** animation to indicate current target */
export async function createArrowPointer(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app
  const arrowContainer = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, arrowImg)

  const arrowSprite = PIXI.Sprite.from(texture!)
  arrowSprite.alpha = 0
  // Anchored at the tip, so positioning places the point itself rather than
  // the middle of the artwork.
  arrowSprite.anchor.set(0.5, 1)
  arrowContainer.addChild(arrowSprite)

  const animManager = new AnimStateManager()
  let holdTimer = 0
  let bobTime = 0
  let hasDrawn = false
  // Smoothed, in canvas pixels.
  let x = 0
  let headTop = 0
  let size = height * MIN_SIZE_FACTOR

  const bobAmplitude = height * BOB_AMPLITUDE_FACTOR

  const place = () => {
    arrowSprite.width = size
    arrowSprite.height = size
    const bob = Math.sin(bobTime * BOB_SPEED) * bobAmplitude
    const tipY = headTop - size * HEAD_CLEARANCE + bob
    // Kept inside the canvas: the arrow used to slide off the top of the
    // frame for anyone standing close enough that their head reached it,
    // taking the marker with it exactly when it mattered.
    const half = arrowSprite.width / 2
    arrowSprite.position.set(
      Math.max(half, Math.min(width - half, x)),
      Math.max(arrowSprite.height, Math.min(height, tipY)),
    )
  }

  const update = (pose: NormalizedLandmarkList) => {
    const dt = ticker.deltaMS / 1000
    const target = getTarget(pose, height, width)

    if (target) {
      holdTimer = HOLD_TIME
      if (!hasDrawn) {
        // Seed on the first real target, or the arrow slides in from the
        // top-left corner the first time it appears.
        x = target.x
        headTop = target.headTop
        size = target.size
        hasDrawn = true
      } else {
        const k = 1 - Math.exp(-FOLLOW_RATE * dt)
        x += (target.x - x) * k
        headTop += (target.headTop - headTop) * k
        size += (target.size - size) * k
      }
    } else {
      holdTimer = Math.max(0, holdTimer - dt)
    }

    animManager.tracking = target !== undefined || holdTimer > 0
    const { time, state } = animManager
    bobTime += dt

    switch (state) {
      case 'exited':
        arrowSprite.alpha = 0
        hasDrawn = false
        bobTime = 0
        break
      case 'entering':
        arrowSprite.alpha = lerpLinear(time, 0, ANIM.FADE)
        place()
        if (time >= ANIM.FADE) animManager.transition()
        break
      case 'entered':
        arrowSprite.alpha = 1
        place()
        break
      case 'lost':
        // The hold timer above already covers brief gaps.
        animManager.transition()
        break
      case 'exiting':
        arrowSprite.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
        place()
        if (time >= ANIM.FADE) {
          arrowSprite.alpha = 0
          hasDrawn = false
          animManager.transition()
        }
        break
    }

    animManager.update(dt)
  }

  return [arrowContainer, update] as const
}
