import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createSlotAssigner } from './slotAssigner'

const HOLD = 1000

/** an assigner on a hand-driven clock, plus the clock's setter */
function setup(slots = 4) {
  let t = 0
  const assign = createSlotAssigner<string>(slots, HOLD, () => t)
  return { assign, at: (ms: number) => (t = ms) }
}

/** which slot each pose landed in, by pose value (undefined if none) */
const slotsOf = (bySlot: (string | undefined)[]) =>
  Object.fromEntries(bySlot.flatMap((p, i) => (p ? [[p, i]] : []))) as Record<
    'a' | 'b' | 'c' | 'n',
    number
  >

describe('slot assigner', () => {
  it('keeps each person in their slot as others come and go', () => {
    const { assign } = setup()
    const first = slotsOf(assign({ 5: 'a', 9: 'b' }))
    const later = slotsOf(assign({ 2: 'c', 5: 'a', 9: 'b' }))
    assert.equal(later.a, first.a)
    assert.equal(later.b, first.b)
  })

  it('gives a briefly hidden person their own slot back', () => {
    const { assign, at } = setup()
    const before = slotsOf(assign({ 5: 'a', 9: 'b' }))
    at(300)
    const hidden = assign({ 9: 'b' })
    assert.equal(hidden[before.a], undefined) // fed nothing while hidden
    at(600)
    const back = slotsOf(assign({ 5: 'a', 9: 'b' }))
    assert.equal(back.a, before.a)
    assert.equal(back.b, before.b)
  })

  it('does not hand a held slot to a newcomer', () => {
    const { assign, at } = setup()
    const before = slotsOf(assign({ 5: 'a' }))
    at(100)
    const withNew = slotsOf(assign({ 7: 'n' }))
    assert.notEqual(withNew.n, before.a)
  })

  it('frees the slot once the hold runs out', () => {
    const { assign, at } = setup(1)
    assign({ 5: 'a' })
    at(100)
    assign({})
    at(100 + HOLD)
    assign({})
    // The slot is free again, so a newcomer takes it.
    assert.deepEqual(assign({ 7: 'n' }), ['n'])
    // And the old id coming back now is a newcomer itself - no slot left.
    at(100 + HOLD + 50)
    assert.deepEqual(assign({ 5: 'a', 7: 'n' }), ['n'])
  })

  it('gives up the oldest hold rather than leave someone present unrendered', () => {
    const { assign, at } = setup(2)
    assign({ 1: 'a', 2: 'b' })
    at(100)
    assign({ 2: 'b' }) // a held from 100
    at(200)
    const out = slotsOf(assign({ 2: 'b', 3: 'c' }))
    assert.equal(out.c !== undefined, true)
    assert.equal(out.b !== undefined, true)
  })
})
