import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { NormalizedLandmark, NormalizedLandmarkList } from '../api/landmarks'
import {
  TorsoAnchor,
  checkHandsHold,
  createLatch,
  getTorsoAnchor,
  stepLatch,
} from './globePose'

const W = 1920
const H = 1080

/** A landmark at a SCREEN pixel position - undoes convertPoint's mirror. */
const px = (x: number, y: number, visibility = 0.9): NormalizedLandmark => ({
  x: 1 - x / W,
  y: y / H,
  visibility,
})

type Pt = [number, number]
interface PoseSpec {
  /** screen-pixel [x, y] for each joint; shoulders default to 860/1060 at
   * y=300 (200px apart), hips 280px below them (1.4 shoulder widths) */
  lElbow: Pt
  rElbow: Pt
  lWrist: Pt
  rWrist: Pt
  hipY?: number
  hipVis?: number
  armVis?: number
  /** scale every x about the frame centre - mimics aspect stretch */
  xScale?: number
  /** swap left/right labels - mimics a horizontal flip */
  swap?: boolean
}

function pose(s: PoseSpec): NormalizedLandmarkList {
  const { hipY = 580, hipVis = 0.9, armVis = 0.9, xScale = 1, swap = false } = s
  const sx = (x: number) => W / 2 + (x - W / 2) * xScale
  const at = ([x, y]: Pt, vis = 0.9) => px(sx(x), y, vis)
  const p: NormalizedLandmarkList = Array.from({ length: 33 }, () => px(960, 540, 0.9))
  const L = { s: at([860, 300]), e: at(s.lElbow, armVis), w: at(s.lWrist, armVis), h: at([880, hipY], hipVis) }
  const R = { s: at([1060, 300]), e: at(s.rElbow, armVis), w: at(s.rWrist, armVis), h: at([1040, hipY], hipVis) }
  const [a, b] = swap ? [R, L] : [L, R]
  ;[p[11], p[13], p[15], p[23]] = [a.s, a.e, a.w, a.h]
  ;[p[12], p[14], p[16], p[24]] = [b.s, b.e, b.w, b.h]
  return p
}

/** Hands held apart at chest height, elbows bent: the real gesture. */
const HOLD: PoseSpec = {
  lElbow: [760, 420], rElbow: [1160, 420],
  lWrist: [800, 400], rWrist: [1120, 400],
}
/** Arms hanging relaxed, slightly flared, wrists beside the hips/groin and
 * 1.7 shoulder widths apart - the pose the old gate mistook for a hold
 * (average wrist y 580 < 300 + 1.5 * 200, separation > 1.2). */
const RELAXED: PoseSpec = {
  lElbow: [820, 480], rElbow: [1100, 480],
  lWrist: [790, 580], rWrist: [1130, 580],
}

const torsoOf = (p: NormalizedLandmarkList, keep = false): TorsoAnchor => {
  const t = getTorsoAnchor(p, H, W, keep)
  assert.ok(t.ok, `torso rejected: ${!t.ok && t.reason}`)
  return t.torso
}
const hands = (s: PoseSpec, keep = false) => {
  const p = pose(s)
  return checkHandsHold(p, H, W, torsoOf(p, keep), keep)
}

describe('checkHandsHold (globe)', () => {
  it('REGRESSION: relaxed arms at the hips are not a hold', () => {
    const r = hands(RELAXED)
    assert.equal(r.ok, false)
    assert.equal(hands(RELAXED, true).ok, false)
  })

  it('one hand at chest and one at the hip is not a hold, even though they average to chest', () => {
    const r = hands({ ...HOLD, rElbow: [1100, 480], rWrist: [1130, 640] })
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.reason : '', /^bandR=/)
  })

  it('hands apart at chest height with bent elbows is a hold, at the wrist midpoint', () => {
    const r = hands(HOLD)
    assert.ok(r.ok)
    if (r.ok) {
      assert.ok(Math.abs(r.x - 960) < 1e-6)
      assert.ok(Math.abs(r.y - 400) < 1e-6)
      assert.ok(Math.abs(r.distance - 320) < 1e-6)
    }
  })

  it('a T-pose is not a hold (keeps the bat gesture from triggering the globe)', () => {
    const r = hands({
      lElbow: [560, 300], rElbow: [1360, 300],
      lWrist: [260, 300], rWrist: [1660, 300],
    })
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.reason : '', /^sep=/)
  })

  it('hips untracked (waist-up framing): the fallback torso length still rejects hip-height wrists', () => {
    const p = pose({ ...RELAXED, hipVis: 0.1 })
    const t = torsoOf(p)
    assert.equal(t.hipsTrusted, false)
    assert.equal(checkHandsHold(p, H, W, t).ok, false)
    // ...and the real gesture still works without hips
    const hp = pose({ ...HOLD, hipVis: 0.1 })
    assert.equal(checkHandsHold(hp, H, W, torsoOf(hp)).ok, true)
  })

  it('hips clipped to the bottom edge are not trusted', () => {
    const p = pose({ ...RELAXED, hipY: H })
    const t = torsoOf(p)
    assert.equal(t.hipsTrusted, false)
    assert.ok(Math.abs(t.torsoLen - 200 * 1.4) < 1e-6)
    assert.equal(checkHandsHold(p, H, W, t).ok, false)
  })

  it('swapped left/right labels (horizontal flip) give the same verdicts', () => {
    assert.equal(hands({ ...HOLD, swap: true }).ok, true)
    assert.equal(hands({ ...RELAXED, swap: true }).ok, false)
  })

  it('a horizontally stretched frame (aspect mismatch) gives the same verdicts', () => {
    for (const xScale of [0.75, 1.33]) {
      assert.equal(hands({ ...HOLD, xScale }).ok, true, `HOLD @ ${xScale}`)
      assert.equal(hands({ ...RELAXED, xScale }).ok, false, `RELAXED @ ${xScale}`)
    }
  })

  it('hysteresis: just outside ACQUIRE but inside KEEP only holds when already held', () => {
    // 3.2 shoulder widths apart: past ACQUIRE's 3.0, inside KEEP's 3.4
    const wide: PoseSpec = {
      lElbow: [600, 420], rElbow: [1320, 420],
      lWrist: [640, 400], rWrist: [1280, 400],
    }
    assert.equal(hands(wide).ok, false)
    assert.equal(hands(wide, true).ok, true)
    // wrists 0.6 torso lengths down: past ACQUIRE's 0.55, inside KEEP's 0.65
    const low: PoseSpec = {
      ...HOLD,
      lElbow: [760, 470], rElbow: [1160, 470],
      lWrist: [800, 468], rWrist: [1120, 468],
    }
    assert.equal(hands(low).ok, false)
    assert.equal(hands(low, true).ok, true)
  })

  it('low arm visibility is not a hold', () => {
    assert.equal(hands({ ...HOLD, armVis: 0.4 }).ok, false)
    assert.equal(hands({ ...HOLD, armVis: 0.4 }, true).ok, true)
  })
})

describe('getTorsoAnchor (globe)', () => {
  it('anchors on the shoulder midpoint, with torso length from the hips', () => {
    const t = torsoOf(pose(HOLD))
    assert.ok(Math.abs(t.x - 960) < 1e-6)
    assert.ok(Math.abs(t.y - 300) < 1e-6)
    assert.ok(Math.abs(t.shoulderWidth - 200) < 1e-6)
    assert.ok(Math.abs(t.torsoLen - 280) < 1e-6)
    assert.equal(t.hipsTrusted, true)
  })

  it('rejects an empty pose', () => {
    assert.equal(getTorsoAnchor([], H, W).ok, false)
  })

  it('rejects shoulders with no visibility (undefined is not "visible")', () => {
    const p = pose(HOLD)
    p[11] = { x: p[11].x, y: p[11].y }
    const r = getTorsoAnchor(p, H, W)
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.reason : '', /^shVis=/)
  })

  it('rejects an unfilled (0,0) shoulder', () => {
    const p = pose(HOLD)
    p[12] = { x: 0, y: 0, visibility: 0.9 }
    const r = getTorsoAnchor(p, H, W)
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'shUnfilled')
  })

  it('rejects confident hips sitting above the shoulders', () => {
    const r = getTorsoAnchor(pose({ ...HOLD, hipY: 200 }), H, W)
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'hipsAboveShoulders')
  })

  it('shoulder visibility: 0.5 to acquire, 0.3 to keep', () => {
    const p = pose(HOLD)
    p[11] = { ...p[11], visibility: 0.4 }
    assert.equal(getTorsoAnchor(p, H, W).ok, false)
    assert.equal(getTorsoAnchor(p, H, W, true).ok, true)
  })
})

describe('stepLatch', () => {
  const opts = { confirmS: 0.2, holdS: 0.45 }
  const TICK = 1 / 60

  it('a single qualifying frame does not turn it on', () => {
    const s = createLatch()
    assert.equal(stepLatch(s, true, TICK, opts), false)
    assert.equal(stepLatch(s, false, TICK, opts), false)
  })

  it('turns on after confirmS of unbroken qualification', () => {
    const s = createLatch()
    let on = false
    for (let t = 0; t < 0.18; t += TICK) on = stepLatch(s, true, TICK, opts)
    assert.equal(on, false)
    for (let t = 0; t < 0.03; t += TICK) on = stepLatch(s, true, TICK, opts)
    assert.equal(on, true)
  })

  it('a gap in confirmation starts the count over', () => {
    const s = createLatch()
    for (let t = 0; t < 0.15; t += TICK) stepLatch(s, true, TICK, opts)
    stepLatch(s, false, TICK, opts)
    for (let t = 0; t < 0.15; t += TICK) stepLatch(s, true, TICK, opts)
    assert.equal(s.on, false)
  })

  it('a gap shorter than holdS does not turn it off; a longer one does', () => {
    const s = createLatch()
    for (let t = 0; t < 0.3; t += TICK) stepLatch(s, true, TICK, opts)
    assert.equal(s.on, true)
    for (let t = 0; t < 0.4; t += TICK) stepLatch(s, false, TICK, opts)
    assert.equal(s.on, true)
    for (let t = 0; t < 0.1; t += TICK) stepLatch(s, false, TICK, opts)
    assert.equal(s.on, false)
  })

  it('stays on through a ~5Hz detection source dropping every other frame', () => {
    // 60Hz ticker; each 200ms detection is replayed for 12 ticks, and every
    // other detection fails - the kind of dropout a slow capture card gives.
    const s = createLatch()
    for (let t = 0; t < 0.3; t += TICK) stepLatch(s, true, TICK, opts)
    let everOff = false
    for (let i = 0; i < 20; i++) {
      const qualified = i % 2 === 0
      for (let k = 0; k < 12; k++) {
        if (!stepLatch(s, qualified, TICK, opts)) everOff = true
      }
    }
    assert.equal(everOff, false)
  })

  it('a flickering gate (the old groin bug) never turns it on', () => {
    // qualifies for 2 ticks, fails for 2 ticks, forever
    const s = createLatch()
    let everOn = false
    for (let i = 0; i < 600; i++) {
      if (stepLatch(s, i % 4 < 2, TICK, opts)) everOn = true
    }
    assert.equal(everOn, false)
  })
})
