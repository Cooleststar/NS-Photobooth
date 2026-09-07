import { useStore } from '@nanostores/preact'
import { useEffect, useState } from 'react'
import 'twin.macro'
import { Countdown, KeybindBtn } from '../components'
import { challenge67Game, getBackendHttpUrl } from '../store'

interface LeaderboardEntry {
  score: number
  ts: number
}

/** Full-screen overlay for 67 Mode, rendered by HUD.tsx in place of its
 * normal ready-state content (camera button/AnimPicker) when
 * challenge67Enabled is on - see store.ts's challenge67Game for why the
 * actual timer/rep-counting logic lives in Display.tsx's ticker instead of
 * here: this component is a pure reader of that shared state, plus the
 * "start" trigger that flips phase to 'countdown'. */
export default function Challenge67UI() {
  const game = useStore(challenge67Game)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])

  const start = () => {
    if (game.phase !== 'waiting' && game.phase !== 'finished') return
    challenge67Game.set({ phase: 'countdown', timeLeft: 0, reps: 0 })
  }

  useEffect(() => {
    if (game.phase !== 'finished') return
    fetch(`${getBackendHttpUrl()}/challenge67/leaderboard`)
      .then((res) => res.json())
      .then((data) => setLeaderboard(data.top ?? []))
      .catch(() => {})
  }, [game.phase])

  switch (game.phase) {
    case 'waiting':
      return (
        <div tw='inset-0 fixed flex flex-col items-center justify-center gap-6'>
          <div tw='text-white text-6xl font-bold bg-black bg-opacity-50 rounded-2xl px-12 py-8'>
            67 Mode
          </div>
          <div tw='text-white text-xl bg-black bg-opacity-50 rounded-xl px-6 py-3'>
            67 as fast as you can for 20 seconds!
          </div>
          <KeybindBtn keyCode='PageUp' onClick={start} tw='text-2xl px-8 py-4'>
            Start
          </KeybindBtn>
        </div>
      )
    case 'countdown':
      return (
        <div tw='inset-0 fixed flex items-center justify-center'>
          <Countdown
            isPlaying
            duration={3}
            colors={['#0af', '#0af']}
            colorsTime={[3, 0]}
          />
        </div>
      )
    case 'playing':
      return (
        <div tw='inset-0 fixed flex flex-col items-center justify-between py-12 pointer-events-none'>
          <div tw='text-white text-2xl font-semibold bg-black bg-opacity-50 rounded-xl px-6 py-3'>
            {Math.max(0, Math.ceil(game.timeLeft))}s left
          </div>
          <div tw='text-white text-8xl font-bold bg-black bg-opacity-50 rounded-2xl px-14 py-10'>
            {game.reps}
          </div>
        </div>
      )
    case 'finished':
      return (
        <div tw='inset-0 fixed flex flex-col items-center justify-center gap-4'>
          <div tw='text-white text-5xl font-bold bg-black bg-opacity-50 rounded-2xl px-12 py-8'>
            Score: {game.lastResult?.score ?? game.reps}
          </div>
          {game.lastResult && (
            <div tw='text-white text-xl bg-black bg-opacity-50 rounded-xl px-6 py-3'>
              Rank {game.lastResult.rank} / {game.lastResult.total}
            </div>
          )}
          {leaderboard.length > 0 && (
            <div tw='text-white text-lg bg-black bg-opacity-50 rounded-xl px-6 py-4 flex flex-col gap-1 min-w-[200px]'>
              <span tw='text-sm text-gray-400 uppercase tracking-widest mb-1'>
                Leaderboard
              </span>
              {leaderboard.slice(0, 10).map((entry, i) => (
                <div key={entry.ts} tw='flex justify-between gap-6'>
                  <span>#{i + 1}</span>
                  <span>{entry.score}</span>
                </div>
              ))}
            </div>
          )}
          <KeybindBtn keyCode='PageUp' onClick={start} tw='text-xl px-6 py-3'>
            Play Again
          </KeybindBtn>
        </div>
      )
  }
}
