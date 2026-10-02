import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { NormalizedLandmark, NormalizedLandmarkList } from '../api/landmarks'
import { HandData } from '../api/nicepipe'
import {
  ELBOW_EXTRA_REACH,
  MAX_HAND_MATCH_FACTOR,
  armAnchors,
  assignHandOwners,
  handsOwnedBy,
} from './scubaHands'

const W = 1920
const H = 1080
const SW = 200 // shoulder width of every test person

/** A landmark at a SCREEN pixel position - undoes convertPoint's mirror. */
const px = (x: number, y: number, visibility = 0.9): NormalizedLandmark => ({
  x: 1 - x / W,
  y: y / H,
  visibility,
})

/** A hand whose detector box centre sits at a SCREEN pixel position. */
const hand = (x: number, y: number): HandData =>
  ({ wx: 1 - x / W, wy: y / H } as unknown as HandData)

/** A person centred at screen x `cx`: shoulders 200px apart at y=400, elbows
 * 150px out at y=550, wrists below them at y=700. */
function person(cx: number, { wristVis = 0.9, elbowVis = 0.9 } = {}): NormalizedLandmarkList {
  const p: NormalizedLandmarkList = Array.from({ length: 33 }, () => px(cx, 300, 0))
  p[11] = px(cx - SW / 2, 400)
  p[12] = px(cx + SW / 2, 400)
  p[13] = px(cx - 150, 550, elbowVis)
  p[14] = px(cx + 150, 550, elbowVis)
  p[15] = px(cx - 150, 700, wristVis)
  p[16] = px(cx + 150, 700, wristVis)
  return p
}

describe('scuba hand ownership', () => {
  it('a hand two people can reach goes only to the nearer one', () => {
    const a = person(600) // right wrist at x=750
    const b = person(1000) // left wrist at x=850
    const allPoses = { 1: a, 2: b }
    const between = hand(790, 700) // 40px from a's wrist, 60px from b's
    assert.equal(assignHandOwners([between], [a, b], H, W).get(between), a)
    assert.deepEqual(handsOwnedBy([between], allPoses, a, H, W), [between])
    assert.deepEqual(handsOwnedBy([between], allPoses, b, H, W), [])
  })

  it('a hand nobody reaches stays available to everyone', () => {
    const a = person(600)
    const b = person(1400)
    const allPoses = { 1: a, 2: b }
    const stray = hand(1000, 100)
    assert.deepEqual(handsOwnedBy([stray], allPoses, a, H, W), [stray])
    assert.deepEqual(handsOwnedBy([stray], allPoses, b, H, W), [stray])
  })

  it('widens the reach to absorb hand lag: 1.3 shoulder widths in, 2 out', () => {
    const a = person(600)
    const near = hand(750 + 1.3 * SW, 700)
    const far = hand(750 + 2 * SW, 700)
    const owners = assignHandOwners([near, far], [a], H, W)
    assert.equal(owners.get(near), a)
    assert.equal(owners.has(far), false)
  })

  it('falls back to the elbow, with a forearm of extra reach, when the wrist is lost', () => {
    const a = person(600, { wristVis: 0.1 })
    const arms = armAnchors(a, H, W, SW)
    assert.equal(arms.right?.src, 'elbow')
    const want = SW * (MAX_HAND_MATCH_FACTOR + ELBOW_EXTRA_REACH)
    assert.ok(Math.abs(arms.right!.radius - want) < 1e-9)
    // a hand a forearm beyond the elbow (elbow at 750,550)
    const h = hand(750, 550 + 1.9 * SW)
    assert.equal(assignHandOwners([h], [a], H, W).get(h), a)
  })

  it("an elbow fallback's bigger reach does not beat a nearer visible wrist", () => {
    const lost = person(600, { wristVis: 0.1 }) // right elbow at 750,550
    const seen = person(1000) // left wrist at 850,700
    const h = hand(830, 690) // ~22px from seen's wrist, ~160px from lost's elbow
    assert.equal(assignHandOwners([h], [lost, seen], H, W).get(h), seen)
  })

  it('no anchor at all without a visible wrist or elbow', () => {
    const a = person(600, { wristVis: 0.1, elbowVis: 0.1 })
    assert.deepEqual(armAnchors(a, H, W, SW), {})
  })

  it('an empty slot (remembered pose) only gets hands nobody owns', () => {
    const a = person(600)
    const owned = hand(750, 700)
    const stray = hand(1500, 100)
    assert.deepEqual(handsOwnedBy([owned, stray], { 1: a }, [], H, W), [stray])
  })

  it('filters nothing in single-person mode or with no people', () => {
    const a = person(600)
    const hs = [hand(750, 700), hand(1500, 100)]
    // single-person mode passes its own copy, not an allPoses entry
    assert.deepEqual(handsOwnedBy(hs, { 1: a }, person(600), H, W), hs)
    assert.deepEqual(handsOwnedBy(hs, {}, a, H, W), hs)
  })
})
