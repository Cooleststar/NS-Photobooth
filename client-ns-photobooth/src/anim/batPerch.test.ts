import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  FLY_FRAME_MS,
  PERCH_FIRST_FLUTTER_S,
  PERCH_FLUTTER_FRAMES,
  PERCH_FLUTTER_MAX_S,
  PERCH_FLUTTER_MIN_S,
  PERCH_IDLE_FRAMES,
  PERCH_SETTLE_FRAMES,
  createPerchState,
  perchBob,
  perchSettleProgress,
  stepPerch,
} from './batPerch'

const DT = 1 / 60

/** runs the perch for `seconds` at 60fps, returning every frame shown. */
function run(seconds: number, rng = () => 0.5) {
  const s = createPerchState()
  const frames: number[] = []
  for (let t = 0; t < seconds; t += DT) frames.push(stepPerch(s, DT, rng))
  return { s, frames }
}

describe('bat perch', () => {
  it('starts from the swoop\'s last pose (Bat.gif frame 0)', () => {
    const s = createPerchState()
    assert.equal(stepPerch(s, 0), 0)
  })

  it('settles into the idle pose, with the sprite fully on the arm', () => {
    const settleS = (PERCH_SETTLE_FRAMES.length * FLY_FRAME_MS) / 1000
    const { s, frames } = run(settleS + 0.05)
    assert.equal(s.phase, 'idle')
    assert.equal(perchSettleProgress(s), 1)
    // walked through the downstroke in order, never backwards
    const settle = frames.filter((_, i) => i * DT < settleS)
    for (let i = 1; i < settle.length; i++) assert.ok(settle[i] >= settle[i - 1])
  })

  it('only shows idle frames between flutters', () => {
    const { frames } = run(PERCH_FIRST_FLUTTER_S)
    const settleN = Math.ceil((PERCH_SETTLE_FRAMES.length * FLY_FRAME_MS) / 1000 / DT) + 1
    for (const f of frames.slice(settleN)) assert.ok(PERCH_IDLE_FRAMES.includes(f), `frame ${f}`)
  })

  it('flutters through a whole flap at the fixed first delay, then returns to idle', () => {
    const s = createPerchState()
    const seen = new Set<number>()
    let flutterStart: number | undefined
    let t = 0
    for (; t < 4; t += DT) {
      const f = stepPerch(s, DT, () => 0)
      if (s.phase === 'flutter') {
        flutterStart ??= t
        seen.add(f)
      }
    }
    // settle + first idle stretch, give or take a tick
    const settleS = (PERCH_SETTLE_FRAMES.length * FLY_FRAME_MS) / 1000
    assert.ok(flutterStart !== undefined)
    assert.ok(Math.abs(flutterStart - (settleS + PERCH_FIRST_FLUTTER_S)) < 2 * DT)
    assert.deepEqual([...seen].sort(), [...new Set(PERCH_FLUTTER_FRAMES)].sort())
    assert.equal(s.phase, 'idle')
  })

  it('schedules later flutters within the jitter range', () => {
    for (const r of [0, 0.5, 0.999]) {
      const s = createPerchState()
      while (!(s.phase === 'idle' && s.nextFlutter !== PERCH_FIRST_FLUTTER_S)) stepPerch(s, DT, () => r)
      assert.ok(s.nextFlutter >= PERCH_FLUTTER_MIN_S && s.nextFlutter <= PERCH_FLUTTER_MAX_S)
    }
  })

  it('fades the breathing bob in over the settle', () => {
    const s = createPerchState()
    assert.equal(perchBob(s), 0)
    for (let t = 0; t < 1; t += DT) stepPerch(s, DT)
    assert.ok(Math.abs(perchBob(s)) <= 1)
  })
})
