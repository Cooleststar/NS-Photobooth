import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { NormalizedLandmark, NormalizedLandmarkList } from '../landmarks'
import { ArmSide, calculateArmFromPose } from './mpPose'

const W = 1920
const H = 1080

/** A landmark at a SCREEN pixel position - undoes convertPoint's mirror. */
const px = (x: number, y: number, visibility: number): NormalizedLandmark => ({
  x: 1 - x / W,
  y: y / H,
  visibility,
})

/** A 33-point pose whose left forearm sits at `leftDeg` from horizontal (on
 * screen) with confidence `leftVis`, and whose right arm hangs straight
 * down - never a qualifying owl perch - unless `rightDeg` is given. */
function pose(
  leftDeg: number,
  leftVis = 0.9,
  rightDeg?: number,
  rightVis = 0.9,
): NormalizedLandmarkList {
  const p: NormalizedLandmarkList = Array.from({ length: 33 }, () => px(960, 540, 0.9))
  const forearm = (elbowX: number, deg: number, vis: number) => {
    const r = (deg * Math.PI) / 180
    return [px(elbowX, 600, vis), px(elbowX - 200 * Math.cos(r), 600 + 200 * Math.sin(r), vis)]
  }
  ;[p[13], p[15]] = forearm(1100, leftDeg, leftVis)
  ;[p[14], p[16]] = rightDeg === undefined
    ? [px(800, 600, rightVis), px(800, 800, rightVis)]
    : forearm(800, rightDeg, rightVis)
  return p
}

const arm = (p: NormalizedLandmarkList, locked?: ArmSide) => {
  const diag: Partial<Record<ArmSide, string>> = {}
  const [side, coords] = calculateArmFromPose(p, H, W, locked, diag)
  return { side, coords, diag }
}

describe('calculateArmFromPose (owl)', () => {
  it('acquires a level, well-tracked forearm', () => {
    const r = arm(pose(0))
    assert.equal(r.side, 'left')
    assert.ok(r.coords)
    assert.equal(r.diag.left, 'ok')
  })

  it('reports noPose for an empty pose', () => {
    const r = arm([])
    assert.equal(r.side, undefined)
    assert.equal(r.diag.left, 'noPose')
  })

  it('needs vis > 0.5 to acquire, but keeps a locked arm down to 0.3', () => {
    assert.equal(arm(pose(0, 0.45)).side, undefined)
    assert.match(arm(pose(0, 0.45)).diag.left!, /^vis=/)
    assert.equal(arm(pose(0, 0.45), 'left').side, 'left')
    assert.equal(arm(pose(0, 0.25), 'left').side, undefined)
  })

  it('needs < 30 degrees to acquire, but keeps a locked arm up to 45', () => {
    assert.equal(arm(pose(20)).side, 'left')
    assert.equal(arm(pose(38)).side, undefined)
    assert.match(arm(pose(38)).diag.left!, /^angle=/)
    assert.equal(arm(pose(38), 'left').side, 'left')
    assert.equal(arm(pose(50), 'left').side, undefined)
  })

  it('keeps the locked arm even when the other is better tracked', () => {
    const both = pose(0, 0.6, 0, 0.95)
    assert.equal(arm(both).side, 'right')
    assert.equal(arm(both, 'left').side, 'left')
  })

  it('a lost lock falls back to the other arm only if it fully qualifies', () => {
    assert.equal(arm(pose(60, 0.9, 0, 0.9), 'left').side, 'right')
    assert.equal(arm(pose(60, 0.9, 38, 0.9), 'left').side, undefined)
  })
})
