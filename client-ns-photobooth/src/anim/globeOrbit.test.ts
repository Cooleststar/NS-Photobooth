import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  BEHIND_FADE_DEPTH,
  ORBIT_SPEED,
  orbitAlpha,
  orbitSpeed,
  stepOrbitAngle,
} from './globeOrbit'

const TICK = 1 / 60
const TWO_PI = Math.PI * 2

/** The opacity formula globe.ts used before it moved here. */
function oldAlpha(angle: number) {
  const t = Math.max(0, Math.min(1, (Math.sin(angle) + BEHIND_FADE_DEPTH) / BEHIND_FADE_DEPTH))
  return t * t * (3 - 2 * t)
}

/** Runs one full lap at 60Hz, timing how long the globe spends fully
 * visible, invisible (<2%), and anywhere short of fully back (<98%). */
function lap(step: (a: number, dt: number) => number) {
  let a = 0
  let total = 0
  let visible = 0
  let invisible = 0
  let gap = 0
  for (;;) {
    const al = orbitAlpha(a)
    if (al >= 0.98) visible += TICK
    if (al < 0.98) gap += TICK
    if (al < 0.02) invisible += TICK
    total += TICK
    const next = step(a, TICK)
    if (next < a) break // wrapped: lap complete
    a = next
  }
  return { total, visible, invisible, gap }
}

const constantSpeed = (a: number, dt: number) => (a + ORBIT_SPEED * dt) % TWO_PI

describe('globe orbit', () => {
  it('leaves the visible front pass exactly as long as at constant speed', () => {
    const before = lap(constantSpeed)
    const after = lap(stepOrbitAngle)
    assert.ok(
      Math.abs(after.visible - before.visible) <= TICK + 1e-9,
      `visible ${after.visible.toFixed(3)} vs ${before.visible.toFixed(3)}`,
    )
  })

  it('shortens the time the globe is gone between passes', () => {
    const before = lap(constantSpeed)
    const after = lap(stepOrbitAngle)
    assert.ok(Math.abs(after.invisible - 1.04) <= 0.1, `invisible ${after.invisible.toFixed(3)}`)
    assert.ok(Math.abs(after.gap - 1.9) <= 0.1, `gap ${after.gap.toFixed(3)}`)
    // ...and it is still a real absence, not an instant reappearance
    assert.ok(after.invisible >= 0.6)
    assert.ok(after.invisible < before.invisible / 2)
  })

  it('opacity is unchanged from the formula globe.ts used before', () => {
    for (let a = 0; a < TWO_PI; a += 0.01) {
      assert.equal(orbitAlpha(a), oldAlpha(a))
    }
  })

  it('runs at the base speed while visible and never slower anywhere', () => {
    for (let a = 0; a < TWO_PI; a += 0.01) {
      const s = orbitSpeed(a)
      assert.ok(s >= ORBIT_SPEED - 1e-12)
      if (orbitAlpha(a) === 1) assert.equal(s, ORBIT_SPEED)
    }
  })

  it('a frame hitch cannot carry the globe further than it used to', () => {
    // From every starting point, one 0.5s delta moves no further than the
    // old constant-speed code did on the same hitch.
    for (let a = 0; a < TWO_PI; a += 0.05) {
      let moved = stepOrbitAngle(a, 0.5) - a
      if (moved < 0) moved += TWO_PI
      assert.ok(moved <= ORBIT_SPEED * 0.5 + 1e-9, `from ${a.toFixed(2)} moved ${moved.toFixed(3)}`)
    }
  })

  it('keeps the angle in [0, 2pi)', () => {
    let a = 0
    for (let i = 0; i < 5000; i++) {
      a = stepOrbitAngle(a, TICK)
      assert.ok(a >= 0 && a < TWO_PI)
    }
    assert.equal(stepOrbitAngle(1, 0), 1)
    assert.equal(stepOrbitAngle(1, -1), 1)
  })
})
