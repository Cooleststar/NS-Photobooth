import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { NormalizedLandmark, NormalizedLandmarkList } from '../api/landmarks'
import { BatArmSide, FOREARM_LAND_RATIO, getForearmTarget } from './batArm'

const W = 1920
const H = 1080

/** A landmark at a SCREEN pixel position - undoes convertPoint's mirror. */
const px = (x: number, y: number, visibility: number): NormalizedLandmark => ({
  x: 1 - x / W,
  y: y / H,
  visibility,
})

interface ArmSpec {
  /** angle between the upper arm and straight down; 90 = T-pose */
  away?: number
  /** elbow bend; 0 = straight */
  bend?: number
  vis?: number
  hipVis?: number
}

/** A 33-point pose built in screen pixels: the left arm per `left`, the right
 * per `right` (hanging at the side - never qualifying - if omitted). The
 * shoulder sits at (900|1020, 400), the hip 400px straight below it. */
function pose(left: ArmSpec, right?: ArmSpec): NormalizedLandmarkList {
  const p: NormalizedLandmarkList = Array.from({ length: 33 }, () => px(960, 540, 0.9))
  const build = (shoulderX: number, dir: 1 | -1, a: ArmSpec) => {
    const { away = 90, bend = 0, vis = 0.9, hipVis = 0.9 } = a
    const up = (away * Math.PI) / 180
    const fore = ((away + bend) * Math.PI) / 180
    const ex = shoulderX + dir * 200 * Math.sin(up)
    const ey = 400 + 200 * Math.cos(up)
    return {
      s: px(shoulderX, 400, vis),
      e: px(ex, ey, vis),
      w: px(ex + dir * 200 * Math.sin(fore), ey + 200 * Math.cos(fore), vis),
      h: px(shoulderX, 800, hipVis),
    }
  }
  const l = build(900, -1, left)
  const r = build(1020, 1, right ?? { away: 0 })
  ;[p[11], p[13], p[15], p[23]] = [l.s, l.e, l.w, l.h]
  ;[p[12], p[14], p[16], p[24]] = [r.s, r.e, r.w, r.h]
  return p
}

const target = (p: NormalizedLandmarkList, locked?: BatArmSide) => {
  const diag: Partial<Record<BatArmSide, string>> = {}
  return { t: getForearmTarget(p, H, W, locked, diag), diag }
}

describe('getForearmTarget (bat)', () => {
  it('acquires a straight T-pose arm and lands along the forearm', () => {
    const { t, diag } = target(pose({}))
    assert.equal(t?.side, 'left')
    assert.equal(diag.left, 'ok')
    // elbow at x=700, wrist at x=500 on screen
    assert.ok(Math.abs(t!.x - (700 - 200 * FOREARM_LAND_RATIO)) < 1e-6)
    assert.ok(Math.abs(t!.y - 400) < 1e-6)
  })

  it('reports noPose for an empty pose', () => {
    assert.equal(target([]).diag.left, 'noPose')
  })

  it('needs vis >= 0.35 to acquire, but keeps a locked arm down to 0.25', () => {
    assert.equal(target(pose({ vis: 0.3 })).t, undefined)
    assert.equal(target(pose({ vis: 0.3 }), 'left').t?.side, 'left')
    assert.equal(target(pose({ vis: 0.2 }), 'left').t, undefined)
  })

  it('needs a tracked hip to acquire, but a locked arm survives losing it', () => {
    const noHip = pose({ hipVis: 0.1 })
    assert.equal(target(noHip).t, undefined)
    assert.match(target(noHip).diag.left!, /^hipVis=/)
    assert.equal(target(noHip, 'left').t?.side, 'left')
  })

  it('without a hip, a locked arm lowered to the side still lets go', () => {
    const { t, diag } = target(pose({ away: 20, hipVis: 0.1 }), 'left')
    assert.equal(t, undefined)
    assert.match(diag.left!, /^away=.*\(noHip\)$/)
  })

  it('away-from-body: 70-120 to acquire, 60-130 to keep', () => {
    assert.equal(target(pose({ away: 125 })).t, undefined)
    assert.equal(target(pose({ away: 125 }), 'left').t?.side, 'left')
    assert.equal(target(pose({ away: 65 }), 'left').t?.side, 'left')
    assert.equal(target(pose({ away: 135 }), 'left').t, undefined)
  })

  it('straightness: 40 degrees of bend to acquire, 50 to keep', () => {
    assert.equal(target(pose({ bend: 30 })).t?.side, 'left')
    assert.equal(target(pose({ bend: 45 })).t, undefined)
    assert.match(target(pose({ bend: 45 })).diag.left!, /^bend=/)
    assert.equal(target(pose({ bend: 45 }), 'left').t?.side, 'left')
    assert.equal(target(pose({ bend: 55 }), 'left').t, undefined)
  })

  it('keeps the locked arm even when the other is better tracked', () => {
    const both = pose({ vis: 0.6 }, { vis: 0.95 })
    assert.equal(target(both).t?.side, 'right')
    assert.equal(target(both, 'left').t?.side, 'left')
  })
})
