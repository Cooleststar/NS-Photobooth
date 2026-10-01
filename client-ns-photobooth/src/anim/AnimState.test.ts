import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { AnimStateManager } from './AnimState'

/** Walks a manager into 'entered' with `t` seconds spent there. */
function entered(opts?: { resumeFromExit?: boolean }, t = 2) {
  const m = new AnimStateManager(opts)
  m.tracking = true
  m.transition()
  m.update(t)
  return m
}

describe('AnimStateManager', () => {
  it('enters on tracking and settles on transition', () => {
    const m = new AnimStateManager()
    assert.equal(m.state, 'exited')
    m.tracking = true
    assert.equal(m.state, 'entering')
    assert.equal(m.time, 0)
    m.transition()
    assert.equal(m.state, 'entered')
  })

  it('a brief loss resumes where it left off', () => {
    const m = entered({}, 2)
    m.tracking = false
    assert.equal(m.state, 'lost')
    m.update(0.5)
    m.tracking = true
    assert.equal(m.state, 'entered')
    assert.equal(m.time, 2)
  })

  it('a sustained loss exits, then re-enters from the start', () => {
    const m = entered()
    m.tracking = false
    m.transition() // lost -> exiting
    assert.equal(m.state, 'exiting')
    m.transition() // exiting -> exited
    assert.equal(m.state, 'exited')
    m.tracking = true
    assert.equal(m.state, 'entering')
    assert.equal(m.time, 0)
  })

  it('by default, tracking during exiting does not cancel the exit', () => {
    const m = entered()
    m.tracking = false
    m.transition()
    m.tracking = true
    assert.equal(m.state, 'exiting')
  })

  it('with resumeFromExit, tracking during exiting resumes the perch', () => {
    const m = entered({ resumeFromExit: true }, 2)
    m.tracking = false
    m.update(1)
    m.transition() // lost -> exiting
    m.update(0.1)
    m.tracking = true
    assert.equal(m.state, 'entered')
    assert.equal(m.time, 2)
  })

  it('with resumeFromExit, a loss mid-entry resumes the entry', () => {
    const m = new AnimStateManager({ resumeFromExit: true })
    m.tracking = true
    m.update(0.7)
    m.tracking = false
    m.transition() // lost -> exiting
    m.tracking = true
    assert.equal(m.state, 'entering')
    assert.equal(m.time, 0.7)
  })

  it('with resumeFromExit, a completed exit still starts fresh', () => {
    const m = entered({ resumeFromExit: true })
    m.tracking = false
    m.transition()
    m.transition() // exiting -> exited
    m.tracking = true
    assert.equal(m.state, 'entering')
    assert.equal(m.time, 0)
  })
})
