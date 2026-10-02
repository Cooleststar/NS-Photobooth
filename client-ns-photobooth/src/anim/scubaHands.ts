// Which detected hands belong to which person, for the scuba gesture. Split
// out of scuba.ts so it can be tested without PIXI or the gif asset that file
// imports. Pure apart from a one-entry memo (see handsOwnedBy).

import { NormalizedLandmarkList } from '../api/landmarks'
import { HandData } from '../api/nicepipe'
import { convertPoint } from '../api/nicepipe/mpPose'

/** Pose confidence needed before a shoulder/wrist/elbow is used. */
export const ANCHOR_MIN_VIS = 0.3
/** How far a hand may sit from its arm's anchor and still count, in shoulder
 * widths. Was 1.0. Hand results arrive one WiLoR cycle behind the pose they
 * are sent with (~100 ms for one person, ~175 ms with four), and a swinging
 * hand covers 0.5-1 shoulder widths in that time - so mid-swing, exactly when
 * it mattered, the hand kept landing outside a 1.0 radius around the CURRENT
 * wrist. Only safe this wide because assignHandOwners stops a neighbour's
 * anchor from claiming the same hand. */
export const MAX_HAND_MATCH_FACTOR = 1.5
/** Extra radius, in shoulder widths, when the elbow stands in for a wrist the
 * pose model lost - the hand is a forearm beyond the elbow. At 3-5 m a person
 * is ~100-150 px tall in the 640x360 frame pose runs on, and a blurred,
 * swinging wrist is the first keypoint to drop under ANCHOR_MIN_VIS. */
export const ELBOW_EXTRA_REACH = 0.8

export type Side = 'left' | 'right'
export type Anchor = { x: number; y: number; radius: number; src: 'wrist' | 'elbow' }
export type ArmAnchors = Partial<Record<Side, Anchor>>

const visible = (lm?: NormalizedLandmarkList[number]) =>
  !!lm && (lm.visibility ?? 1) >= ANCHOR_MIN_VIS

/** Shoulder width in screen pixels, or undefined without two usable
 * shoulders - the same test scuba.ts's getTorso applies. */
export function shoulderWidthOf(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
): number | undefined {
  const ls = pose[11]
  const rs = pose[12]
  if (!visible(ls) || !visible(rs)) return undefined
  const l = convertPoint(ls, height, width)
  const r = convertPoint(rs, height, width)
  const sw = Math.hypot(l.x - r.x, l.y - r.y)
  return sw >= 1 ? sw : undefined
}

/** Where each of this person's hands should be looked for: the wrist when the
 * pose model can see it, else the elbow with a forearm's extra reach. */
export function armAnchors(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
  shoulderWidth: number,
): ArmAnchors {
  const out: ArmAnchors = {}
  const radius = shoulderWidth * MAX_HAND_MATCH_FACTOR
  for (const [side, wi, ei] of [['left', 15, 13], ['right', 16, 14]] as const) {
    if (visible(pose[wi])) {
      const p = convertPoint(pose[wi], height, width)
      out[side] = { x: p.x, y: p.y, radius, src: 'wrist' }
    } else if (visible(pose[ei])) {
      const p = convertPoint(pose[ei], height, width)
      out[side] = {
        x: p.x, y: p.y, radius: radius + shoulderWidth * ELBOW_EXTRA_REACH, src: 'elbow',
      }
    }
  }
  return out
}

/** Hand centre in screen pixels - WiLoR's own detector box centre, mirrored
 * to match the pose landmarks (see scuba.ts's handPos). */
export function handScreenPos(h: HandData, height: number, width: number) {
  return { x: (1 - h.wx) * width, y: h.wy * height }
}

/** Gives each hand to the ONE person whose anchor is nearest, among anchors
 * that reach it. Hands no anchor reaches are left out of the map (unowned).
 *
 * Every scuba instance used to match against the shared hand list on its own,
 * so a hand within reach of two people's wrists counted for both: a cat over
 * a still neighbour's head, or a neighbour's hand polluting the swinging
 * person's motion buffer. */
export function assignHandOwners<P extends NormalizedLandmarkList>(
  hands: HandData[],
  poses: P[],
  height: number,
  width: number,
): Map<HandData, P> {
  const anchors: { pose: P; a: Anchor }[] = []
  for (const pose of poses) {
    const sw = shoulderWidthOf(pose, height, width)
    if (sw === undefined) continue
    const arms = armAnchors(pose, height, width, sw)
    for (const a of [arms.left, arms.right]) if (a) anchors.push({ pose, a })
  }
  const owners = new Map<HandData, P>()
  for (const hand of hands) {
    const p = handScreenPos(hand, height, width)
    let best: P | undefined
    let bestD = Infinity
    for (const { pose, a } of anchors) {
      const d = Math.hypot(p.x - a.x, p.y - a.y)
      if (d <= a.radius && d < bestD) {
        bestD = d
        best = pose
      }
    }
    if (best) owners.set(hand, best)
  }
  return owners
}

let memo:
  | { hands: HandData[]; allPoses: object; height: number; width: number; owners: Map<HandData, NormalizedLandmarkList> }
  | undefined

/** The hands a scuba instance driving `pose` may use: its own, plus any no
 * one owns.
 *
 * - `pose` is one of `allPoses` (Multi-Person Tracking - the slot assigner
 *   hands each instance `allPoses[id]` itself): its own + unowned.
 * - `pose` is empty (a slot with nobody in it right now, which scuba bridges
 *   with its remembered pose): unowned only, so it can't take a hand from
 *   someone who IS in frame.
 * - `pose` is anything else (single-person mode passes its own copy): every
 *   hand, exactly as before this existed.
 *
 * Ownership is worked out once per frame and shared by every instance, since
 * all of them call this with the same hands/allPoses objects. */
export function handsOwnedBy(
  hands: HandData[],
  allPoses: { [id: number]: NormalizedLandmarkList },
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
): HandData[] {
  const poses = Object.values(allPoses)
  if (hands.length === 0 || poses.length === 0) return hands
  if (pose.length > 0 && !poses.includes(pose)) return hands
  if (
    !memo || memo.hands !== hands || memo.allPoses !== allPoses ||
    memo.height !== height || memo.width !== width
  ) {
    memo = { hands, allPoses, height, width, owners: assignHandOwners(hands, poses, height, width) }
  }
  const owners = memo.owners
  return hands.filter((h) => {
    const o = owners.get(h)
    return o === undefined || (pose.length > 0 && o === pose)
  })
}
