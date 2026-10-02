import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  PERCH_BLEND_S,
  PERCH_FIRST_FLUTTER_S,
  PERCH_FLUTTER_MAX_S,
  PERCH_FLUTTER_MIN_S,
  PERCH_FLUTTER_S,
  createPerchState,
  perchBob,
  perchSettleProgress,
  perchWingStretch,
  stepPerch,
} from './batPerch'

const DT = 1 / 60

describe('bat perch', () => {
  it('blends in from the swoop over the settle, then idles', () => {
    const s = createPerchState()
    assert.equal(perchSettleProgress(s), 0)
    let last = 0
    for (let t = 0; t < PERCH_BLEND_S - DT; t += DT) {
      stepPerch(s, DT)
      const p = perchSettleProgress(s)
      assert.ok(p >= last && p <= 1) // only ever moves forward
      last = p
    }
    for (let t = 0; t < 2 * DT; t += DT) stepPerch(s, DT)
    assert.equal(s.phase, 'idle')
    assert.equal(perchSettleProgress(s), 1)
  })

  it('stays still between stretches', () => {
    const s = createPerchState()
    for (let t = 0; t < PERCH_BLEND_S + PERCH_FIRST_FLUTTER_S - 2 * DT; t += DT) {
      stepPerch(s, DT)
      assert.equal(perchWingStretch(s), 0)
    }
  })

  it('stretches once at the fixed first delay, out and back, then idles', () => {
    const s = createPerchState()
    let start: number | undefined
    let end: number | undefined
    let peak = 0
    let t = 0
    for (; t < PERCH_BLEND_S + PERCH_FIRST_FLUTTER_S + PERCH_FLUTTER_S + 0.2; t += DT) {
      stepPerch(s, DT, () => 0)
      if (s.phase === 'flutter') {
        start ??= t
        peak = Math.max(peak, perchWingStretch(s))
      } else if (start !== undefined) {
        end ??= t
      }
    }
    assert.ok(start !== undefined && end !== undefined)
    assert.ok(Math.abs(start - (PERCH_BLEND_S + PERCH_FIRST_FLUTTER_S)) < 2 * DT)
    assert.ok(Math.abs(end - start - PERCH_FLUTTER_S) < 2 * DT)
    assert.ok(peak > 0.95 && peak <= 1)
    assert.equal(s.phase, 'idle')
    assert.equal(perchWingStretch(s), 0)
  })

  it('schedules later stretches within the jitter range', () => {
    for (const r of [0, 0.5, 0.999]) {
      const s = createPerchState()
      while (!(s.phase === 'idle' && s.nextFlutter !== PERCH_FIRST_FLUTTER_S)) stepPerch(s, DT, () => r)
      assert.ok(s.nextFlutter >= PERCH_FLUTTER_MIN_S && s.nextFlutter <= PERCH_FLUTTER_MAX_S)
    }
  })

  it('fades the breathing in over the settle', () => {
    const s = createPerchState()
    assert.equal(perchBob(s), 0)
    for (let t = 0; t < 1; t += DT) stepPerch(s, DT)
    assert.ok(Math.abs(perchBob(s)) <= 1)
  })
})
