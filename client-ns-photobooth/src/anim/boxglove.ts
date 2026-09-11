import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { HandData } from '../api/nicepipe'
import { AnimStateManager } from './AnimState'

import gloveImg from '../assets/boxglove/boxingglove.png'

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// Must match WILOR_MAX_HANDS in backend/wilor_hands.py, same as DRONE_SLOTS.
// One glove per hand, so a group of four with both fists up fills it exactly.
const GLOVE_SLOTS = 8

// How long a glove survives losing its hand, and how long a fist must be held
// before one appears. Same reasoning as drone.ts's PALM_HOLD_TIME /
// PALM_CONFIRM_TIME: the hold rides out detection flicker, the confirm stops a
// single misread frame summoning a glove mid-gesture.
const FIST_HOLD_TIME = 0.4
const FIST_CONFIRM_TIME = 0.15

// Rendered position eases toward the tracked one at this rate per second,
// framerate-independent. See drone.ts's FOLLOW_RATE: the backend updates far
// slower than the display refreshes, so without this the glove jumps.
const FOLLOW_RATE = 18

// Rotation is smoothed separately from position. A rotation wobble is more
// visible than a positional one, since it swings the whole length of the
// glove - but the source turns out to be clean: measured on a held fist,
// WiLoR's angle varied only about 3 degrees over ten seconds.
//
// So this is damping, not noise removal, and does not need to be heavy. Was
// 4.5, which added visible lag for nothing. Lower is steadier, higher follows
// a real turn faster.
const ANGLE_FOLLOW_RATE = 10

// The glove is sized from the hand's DETECTED BOX rather than a fixed size, so
// it grows and shrinks as someone moves toward or away from the camera. A real
// glove covers the fist plus a stretch of forearm, hence wider than the box.
// Tuned by eye against captured photos. 1.55 and 1.32 both read far too large
// - a glove spanning chin to above head height - but that was measured before
// GLOVE_ANCHOR was corrected, which had the glove sitting low and looking
// bulkier than it was. 0.95 then read slightly small once the anchor was
// right. 1.15 was still small enough to leave knuckles showing above the
// glove, so this is larger again - a real glove is a good deal wider than the
// fist inside it. Raised repeatedly against captured photos: 1.15, then 1.50,
// then this. The early "too big" readings at 1.32 and 1.55 were taken while
// the anchor was wrong and the glove sat low, which flattered them.
const GLOVE_WIDTH_FACTOR = 1.85

// Where on the art the hand sits.
//
// Was 0.22, the widest point of the padded body - which put the anchor on the
// fist correctly but left only 22% of the glove above it. A fist is taller
// than that, so the knuckles showed above the glove's top edge while the cuff
// ran too far down the forearm. Compared against a bare-fist photo in the same
// pose, the glove needed to sit roughly a third of its height higher.
//
// A worn glove has the fist INSIDE the padded body rather than at its top
// edge, so the anchor belongs nearer the middle of that padding. Nudged 0.34
// to 0.38 alongside the size increase: growing the sprite alone only adds
// ~34% of the extra height above the hand, and knuckles were still showing.
// Raised again to 0.44 with the same symptom persisting - the anchor is now
// close to the middle of the padded body, which is where a fist actually sits
// inside a glove.
const GLOVE_ANCHOR = { x: 0.5, y: 0.44 }

// Extra horizontal stretch, applied to width only.
//
// GLOVE_WIDTH_FACTOR drives height too, through the art's aspect ratio, so
// raising it to cover the sides of a hand also pushes the cuff further down
// the forearm - and the vertical fit is already right. This widens without
// lengthening.
//
// It does distort the art, but a boxing glove is a soft, rounded object with
// no straight edges or text, so a modest stretch reads as a chunkier glove
// rather than a squashed image.
//
// Raised 1.2 -> 1.35 after a burst shot showed the side of a hand past the
// glove's inner edge on one frame of three. The exposure is intermittent
// because it depends on how the hand is turned: a flat sprite cannot match a
// hand's silhouette through 3D rotation, so this covers the worst case at the
// cost of looking slightly wide in the best one.
const GLOVE_STRETCH = 1.35

// The art points UP; `angle` from the backend is measured from +x. A quarter
// turn converts between the two.
const ART_UP_OFFSET = Math.PI / 2

// How far a slot may reach to claim a hand, as a fraction of screen width.
// Same as drone.ts's MAX_CLAIM_DISTANCE_FACTOR and for the same reasons.
const MAX_CLAIM_DISTANCE_FACTOR = 0.25

// Fist detection is a Schmitt trigger rather than one threshold. Measured on
// live hands, the two states nearly touch:
//
//     open hand   0.49 .. 0.78
//     fist        0.97 .. 1.07
//
// A single cutoff at 0.9 leaves ~0.12 of margin each way, so a relaxed fist
// sitting near the line switches the glove on and off frame to frame. The
// backend's `fist` flag is the strict test used to APPEAR; once a glove is on
// it stays on while curl holds above this looser value.
const FIST_EXIT_CURL = 0.8

interface GloveTarget {
  x: number
  y: number
  angle: number
  size: number
  /** The backend's strict fist test. A slot needs this to acquire a hand, but
   * not to keep one - see FIST_EXIT_CURL. */
  isFist: boolean
  /** Whether this is a right hand, and whether that is worth believing. */
  isRight: boolean
  handednessTrusted: boolean
}

/** Match fists to glove slots, nearest pair first, with a reach limit.
 *
 * Same approach as drone.ts's assignHandsToDrones: a slot whose hand blinks
 * out for one frame must not grab a distant hand, and slot order is arbitrary
 * so an early slot must not take a hand that better suits a later one. */
function assignHandsToGloves(
  hands: HandData[],
  tracked: Array<{ x: number; y: number; active: boolean }>,
  height: number,
  width: number,
): Array<GloveTarget | undefined> {
  // Loose filter: anything closed enough to KEEP a glove. Whether it is closed
  // enough to summon one is carried per-hand as isFist, and checked by the
  // slot - a slot that already has a glove accepts the looser test.
  const candidates = hands.filter((h) => h.fist || h.curl > FIST_EXIT_CURL)

  // No duplicate filtering here on purpose. A near-distance dedupe was added
  // and then removed: the evidence for duplicate detections was three hands in
  // a TWO-PERSON frame, which is simply normal, and only one of the three was
  // a fist - so two gloves on one hand was never possible. The flicker it was
  // meant to explain was a single sprite flipping its mirror, fixed by
  // latching `facing`.
  //
  // It would also be actively harmful in this animation: two fists held up in
  // a boxing guard sit well within any plausible duplicate threshold, so it
  // would suppress the second glove in exactly the pose this character exists
  // for.
  const available: GloveTarget[] = candidates.map((h) => ({
    // The feed is mirrored for display, so x flips and the rotation with it.
    x: (1 - h.x[0]) * width,
    y: h.y[0] * height,
    angle: Math.PI - h.angle,
    size: Math.max(h.w * width, h.h * height),
    isFist: h.fist,
    isRight: h.label === 'Right',
    // Only MediaPipe's answer is trusted. WiLoR's own label is the fallback
    // and is not good enough to mirror on - see HandData.labelSrc.
    handednessTrusted: h.labelSrc === 'mp',
  }))

  const result: Array<GloveTarget | undefined> = tracked.map(() => undefined)
  const claimed = new Set<number>()
  const maxClaim = width * MAX_CLAIM_DISTANCE_FACTOR

  const pairs: Array<{ slot: number; hand: number; d: number }> = []
  for (let i = 0; i < tracked.length; i++) {
    for (let j = 0; j < available.length; j++) {
      const d = Math.hypot(available[j].x - tracked[i].x, available[j].y - tracked[i].y)
      if (d <= maxClaim) pairs.push({ slot: i, hand: j, d })
    }
  }
  pairs.sort((a, b) => a.d - b.d)

  const usedSlot = new Set<number>()
  for (const { slot, hand } of pairs) {
    if (usedSlot.has(slot) || claimed.has(hand)) continue
    result[slot] = available[hand]
    usedSlot.add(slot)
    claimed.add(hand)
  }

  // Unclaimed fists go to IDLE slots at any distance: an idle slot is not on
  // screen, so there is nothing to teleport. Active slots are excluded so a
  // visible glove never jumps to someone else's hand.
  const idle = result
    .map((r, i) => (r === undefined && !tracked[i].active ? i : -1))
    .filter((i) => i >= 0)
  for (let j = 0; j < available.length && idle.length; j++) {
    if (claimed.has(j)) continue
    result[idle.shift()!] = available[j]
    claimed.add(j)
  }
  return result
}

async function createGlove(app: PIXI.Application) {
  const { ticker, loader } = app
  const container = new PIXI.Container()

  const { texture } = await PIXI.ensureLoaded(loader, gloveImg)
  const sprite = PIXI.Sprite.from(texture!)
  sprite.anchor.set(GLOVE_ANCHOR.x, GLOVE_ANCHOR.y)
  container.addChild(sprite)

  const aspect = texture!.height / texture!.width

  const kf = { x: new KalmanFilter(KF_PARAMS), y: new KalmanFilter(KF_PARAMS) }

  let x = 0
  let y = 0
  // Rotation is carried as a DIRECTION VECTOR rather than an angle, because an
  // angle wraps at +/-180 degrees: smoothing it directly makes the glove spin
  // the long way round whenever the hand crosses that seam. A unit vector has
  // no seam, so it can be averaged safely and converted back at draw time.
  let dirX = 1
  let dirY = 0
  let size = 100
  // +1 draws the art as-is, -1 mirrors it for the other hand.
  //
  // Read EVERY FRAME from the hand, not latched to the slot. Latching was a
  // workaround for WiLoR's unreliable label, and it made things worse: facing
  // belonged to the slot while hands move between slots, so two gloves would
  // trade hands and both show the wrong mirror, alternating. MediaPipe's
  // handedness is stable at 0.98+, so the correct fix is to let the mirror
  // follow the hand.
  let facing = 1
  let drawnX = 0
  let drawnY = 0
  let hasDrawn = false
  let holdTimer = 0
  let confirmTimer = 0

  /** Drop the eased position so a glove re-acquired elsewhere appears there
   * rather than flying across. Kept out of initialState(), which runs during
   * setup before these bindings exist - see drone.ts's resetEasing. */
  const resetEasing = () => {
    hasDrawn = false
  }

  const animManager = new AnimStateManager()

  const initialState = () => {
    container.alpha = 0
  }
  initialState()

  const getTrackedPos = () => ({ x, y, active: animManager.tracking })

  const update = (target: GloveTarget | undefined) => {
    if (target) {
      holdTimer = FIST_HOLD_TIME
      // Only a strict fist counts toward first appearing; a merely half-closed
      // hand can hold a glove but never summon one.
      confirmTimer = target.isFist
        ? Math.min(FIST_CONFIRM_TIME, confirmTimer + ticker.deltaMS / 1000)
        : 0
      x = kf.x.filter(target.x)
      y = kf.y.filter(target.y)
      size = target.size
      // The feed is mirrored for display (x is flipped when positioning
      // above), so the sprite mirror is inverted relative to the raw label: a
      // right hand appears on screen as its mirror image. Untrusted handedness
      // keeps whatever was last drawn rather than guessing.
      if (target.handednessTrusted) facing = target.isRight ? -1 : 1
      // Ease the direction vector toward the target's, then renormalise.
      // Averaging two unit vectors and renormalising is a rotation-safe way to
      // move part of the way between two headings, with no wraparound case.
      const k = 1 - Math.exp(-ANGLE_FOLLOW_RATE * (ticker.deltaMS / 1000))
      const tx = Math.cos(target.angle)
      const ty = Math.sin(target.angle)
      dirX += (tx - dirX) * k
      dirY += (ty - dirY) * k
      const len = Math.hypot(dirX, dirY) || 1
      dirX /= len
      dirY /= len
      if (!hasDrawn) {
        drawnX = x
        drawnY = y
        // Seed the heading too, or the first glove of a session visibly
        // sweeps round from pointing right.
        dirX = tx
        dirY = ty
        hasDrawn = true
      }
    } else {
      holdTimer = Math.max(0, holdTimer - ticker.deltaMS / 1000)
      confirmTimer = 0
    }

    if (hasDrawn) {
      const k = 1 - Math.exp(-FOLLOW_RATE * (ticker.deltaMS / 1000))
      drawnX += (x - drawnX) * k
      drawnY += (y - drawnY) * k
    }

    animManager.tracking = animManager.tracking
      // Already worn: any candidate keeps it, including one that has relaxed
      // below the strict fist test but stayed above FIST_EXIT_CURL.
      ? target !== undefined || holdTimer > 0
      // Not worn yet: needs a definite fist, held for the confirm window.
      : confirmTimer >= FIST_CONFIRM_TIME

    const { time, state } = animManager

    const place = () => {
      const w = size * GLOVE_WIDTH_FACTOR
      // Width is set and height derived, so the art keeps its aspect. Taking
      // both from the box would squash it, a hand box being far squarer than
      // a glove.
      //
      // Both set POSITIVE, with the mirror applied to scale.x afterwards.
      // PIXI's width setter is `scale.x = sign(scale.x) * value / texWidth` -
      // it multiplies by the sign already there. Passing a negative width
      // therefore flips the sign on every single frame:
      //
      //     frame 1   sign +1 x (-w)  ->  negative
      //     frame 2   sign -1 x (-w)  ->  positive
      //
      // which strobed at frame rate, and only on the mirrored hand. The
      // backend was innocent: its handedness logged rock-steady at 0.98+
      // throughout.
      sprite.width = w * GLOVE_STRETCH
      sprite.height = w * aspect
      sprite.scale.x = Math.abs(sprite.scale.x) * facing
      sprite.rotation = Math.atan2(dirY, dirX) + ART_UP_OFFSET
      container.position.set(drawnX, drawnY)
    }

    switch (state) {
      case 'exited':
        initialState()
        resetEasing()
        break
      case 'entering':
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        place()
        if (time >= ANIM.FADE) animManager.transition()
        break
      case 'entered':
        container.alpha = 1
        place()
        break
      case 'lost':
        // No re-track grace: the hold timer above already covers brief gaps.
        animManager.transition()
        break
      case 'exiting':
        container.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
        place()
        if (time >= ANIM.FADE) {
          initialState()
          resetEasing()
          animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [container, update, getTrackedPos] as const
}

/** Boxing gloves worn on closed fists, one per detected hand.
 *
 * Mirrored per hand, but only on a handedness worth believing. WiLoR cannot
 * supply that: it flips left-hand crops before the network sees them
 * (vitdet_dataset.py), so the whole left/right decision rests on a small
 * detector class that reported three hands in one frame as all "Left".
 * Mirroring from it made the glove strobe.
 *
 * MediaPipe's hand model predicts handedness directly and reads 0.98+ on this
 * camera, verified against a known hand. The backend runs it on CPU purely for
 * that one bit and marks each hand's labelSrc accordingly; this only mirrors
 * when that says 'mp'.
 *
 * Reads `fist` from the backend, which is derived from WiLoR's predicted
 * finger-joint rotations rather than landmarks: WiLoR's landmarks are all the
 * bounding-box centre, so hand SHAPE cannot be read from them at all (see
 * wilor_hands.py). `angle` and the box size come from the same place, so the
 * glove rotates with the hand and scales with distance from the camera. */
export async function createBoxGloveAnim(app: PIXI.Application) {
  const { height, width } = app.renderer

  const gloves = await Promise.all(
    Array.from({ length: GLOVE_SLOTS }, () => createGlove(app)),
  )

  const parentContainer = new PIXI.Container()
  for (const [container] of gloves) parentContainer.addChild(container)

  const update = (hands: HandData[]) => {
    const tracked = gloves.map(([, , getPos]) => getPos())
    const assigned = assignHandsToGloves(hands, tracked, height, width)
    gloves.forEach(([, updateSlot], i) => updateSlot(assigned[i]))
  }

  return [parentContainer, update] as const
}
