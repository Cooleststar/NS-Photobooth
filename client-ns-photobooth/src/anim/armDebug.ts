// Diagnostics for the arm-perching characters (owl, bat) - the same idea as
// scuba.ts's SCUBA_LOG, for the same reason: their per-frame gates either
// pass or fail silently, so "the owl keeps leaving" looks identical whether
// the person vanished, a visibility score dipped, or an angle drifted past
// its limit. This records WHICH gate failed, with the numbers it failed on.
//
// Recorded always (cheap: only on change, plus a heartbeat), printed only on
// request - toggle from the browser console without restarting anything:
//
//   window.ARM_DEBUG = true     // print lines live
//   copy(armDump())             // copy the history to the clipboard

declare global {
  interface Window {
    ARM_DEBUG?: boolean
    ARM_LOG?: string[]
    armDump?: () => string
  }
}

/** ~5 minutes of activity at typical change rates. */
const LOG_HISTORY = 600
/** A line is written whenever the summary changes, and at least this often
 * while anything is being tracked, so a stable stretch still shows up. */
const HEARTBEAT_MS = 1000

export interface ArmDebugSample {
  /** animation state from AnimStateManager */
  state: string
  /** arm the animation is locked onto, if any */
  locked?: string
  /** per-side gate outcome: 'ok' or the failed gate with its numbers */
  left?: string
  right?: string
  /** free-form timer readout, e.g. grace/hold/confirm */
  timers: string
}

/** One logger per animation instance. */
export function createArmDebugLogger(name: string) {
  let lastSummary = ''
  let lastAt = 0
  const start = typeof performance !== 'undefined' ? performance.now() : 0

  return (s: ArmDebugSample) => {
    if (typeof window === 'undefined') return
    const now = performance.now()
    // The timers tick every frame, so they are left out of the change test -
    // otherwise every frame would count as a change.
    const summary = `${s.state} lock=${s.locked ?? '-'} L=${s.left ?? '-'} R=${s.right ?? '-'}`
    const idle = s.state === 'exited' && !s.locked && s.left === s.right
    const changed = summary !== lastSummary
    if (!changed && (idle || now - lastAt < HEARTBEAT_MS)) return
    lastSummary = summary
    lastAt = now

    const t = ((now - start) / 1000).toFixed(2)
    const text = `[${name} ${t}s] ${summary} ${s.timers}`
    window.armDump ??= () => (window.ARM_LOG ?? []).join('\n')
    const history = (window.ARM_LOG ??= [])
    history.push(text)
    if (history.length > LOG_HISTORY) history.shift()
    if (window.ARM_DEBUG === true) console.log(text)
  }
}

/** Formats a number for the log. */
export const f2 = (n: number | undefined) => (n === undefined || isNaN(n) ? '?' : n.toFixed(2))
