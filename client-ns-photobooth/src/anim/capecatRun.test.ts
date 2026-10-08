import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { HOP_HEIGHT, RUN_HOPS, SQUASH, runFrame } from './capecatRun'

const D = 1.2

describe('caped cat run', () => {
  it('starts at the corner and ends on the arm, never going backwards', () => {
    assert.equal(runFrame(0, D).progress, 0)
    assert.equal(runFrame(D, D).progress, 1)
    let prev = -1
    for (let t = 0; t <= D; t += 0.01) {
      const p = runFrame(t, D).progress
      assert.ok(p >= prev - 1e-12)
      prev = p
    }
  })

  it('is on the ground at both ends of the run', () => {
    assert.ok(runFrame(0, D).hop < 1e-9)
    assert.ok(runFrame(D, D).hop < 1e-9)
    assert.equal(runFrame(D * 2, D).hop, 0) // past the end: settled
  })

  it('hops RUN_HOPS times, each lower than the last', () => {
    const peaks: number[] = []
    let prev = 0
    let rising = true
    for (let t = 0; t <= D; t += D / 600) {
      const h = runFrame(t, D).hop
      if (rising && h < prev) {
        peaks.push(prev)
        rising = false
      } else if (!rising && h > prev) {
        rising = true
      }
      prev = h
    }
    assert.equal(peaks.length, RUN_HOPS)
    for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i] < peaks[i - 1])
    assert.ok(peaks[0] <= HOP_HEIGHT)
  })

  it('squashes only around touchdowns, never mid-air or after arriving', () => {
    const midAir = runFrame(D / (2 * RUN_HOPS), D) // top of the first arch
    assert.equal(midAir.squash, 0)
    const touchdown = runFrame(D / RUN_HOPS, D) // end of the first arch
    assert.ok(touchdown.squash > 0 && touchdown.squash <= SQUASH)
    assert.equal(runFrame(D, D).squash, 0)
  })

  it('takes off without a crouch and lands without a jump in squash', () => {
    assert.equal(runFrame(0, D).squash, 0)
    assert.equal(runFrame(D / 100, D).squash, 0)
    // Into the end of the run the squash fades out rather than cutting to 0.
    assert.ok(runFrame(D * 0.999, D).squash < SQUASH * 0.01)
  })

  it('handles a zero-length run as already arrived', () => {
    assert.deepEqual(runFrame(0, 0), { progress: 1, hop: 0, squash: 0 })
  })
})
