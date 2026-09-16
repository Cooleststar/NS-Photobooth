import { NormalizedLandmarkList } from '../../api/landmarks'
import { challenge67Game, getBackendHttpUrl } from '../../store'
import { createRepCounter } from './repCounter'

/** How long the "get ready" countdown runs before reps start counting.
 * Challenge67UI renders its own <Countdown duration={3}> for the same phase -
 * keep the two in step. */
const COUNTDOWN_SEC = 3
/** Length of a scored round. */
const ROUND_SEC = 20

/** POSTs a finished round's score and folds the response into
 * challenge67Game.lastResult. */
export function submitChallenge67Score(score: number) {
  fetch(`${getBackendHttpUrl()}/challenge67/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // playerName was confirmed by Challenge67UI's 'naming' screen before
    // 'countdown' ever starts, so it's already sitting on the shared atom by
    // the time a round can end.
    body: JSON.stringify({ score, name: challenge67Game.get().playerName }),
  })
    .then((res) => res.json())
    .then((data) => {
      // `top` comes straight from this response, not a separate GET - a GET
      // fired off the 'finished' phase transition used to race this very
      // POST and could win, showing the leaderboard as it looked BEFORE this
      // round's score was written. See Challenge67UI.tsx and
      // Challenge67State.lastResult.
      challenge67Game.set({
        ...challenge67Game.get(),
        lastResult: {
          score,
          best: data.best ?? score,
          isNewBest: data.isNewBest ?? true,
          rank: data.rank,
          total: data.total,
          top: data.top ?? [],
        },
      })
    })
    .catch((e) => console.warn('Failed to submit 67 Mode score:', e))
}

/** 67 Mode's per-frame driver: owns the countdown clock, the rep counter and
 * the phase transitions, and is stepped once per rendered frame.
 *
 * This lives here rather than in Challenge67UI because it needs the two
 * things only the render loop has - the frame's pose data and a running
 * clock - so Challenge67UI stays a pure reader of challenge67Game (see the
 * comment on that atom in store.ts). It is a factory rather than a bare
 * function so the countdown's elapsed time is owned by the loop itself
 * instead of being another mutable variable in Display.tsx's setup effect. */
export function createChallenge67Loop() {
  const repCounter = createRepCounter()
  let phaseElapsed = 0

  return {
    /** @param pose this frame's 67-Mode pose (MediaPipe's, not YOLO's)
     *  @param deltaSec seconds since the previous frame */
    tick(pose: NormalizedLandmarkList | undefined, deltaSec: number) {
      const game = challenge67Game.get()

      if (game.phase === 'countdown') {
        phaseElapsed += deltaSec
        if (phaseElapsed >= COUNTDOWN_SEC) {
          phaseElapsed = 0
          repCounter.reset()
          challenge67Game.set({ ...game, phase: 'playing', timeLeft: ROUND_SEC, reps: 0 })
        }
        return
      }

      if (game.phase !== 'playing') return

      const reps = game.reps + repCounter.processFrame(pose, performance.now())
      const timeLeft = game.timeLeft - deltaSec
      if (timeLeft > 0) {
        challenge67Game.set({ ...game, phase: 'playing', timeLeft, reps })
        return
      }

      // lastResult is cleared explicitly rather than carried over by the
      // spread: it still holds the PREVIOUS round's score/rank/leaderboard
      // at this point, which would flash on the results screen until this
      // round's submit response lands.
      challenge67Game.set({ ...game, phase: 'finished', timeLeft: 0, reps, lastResult: undefined })
      submitChallenge67Score(reps)
    },
  }
}
