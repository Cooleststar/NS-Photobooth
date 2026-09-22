import { useStore } from '@nanostores/preact'
import { useNiceROSState } from 'nice-ros-react'
import { useEffect, useRef, useState } from 'react'
import tw from 'twin.macro'
import { Countdown, KeybindBtn } from '../components'
import { Challenge67LeaderboardEntry, challenge67Game, getBackendHttpUrl } from '../store'

// Kept short: it's rendered as a leaderboard column, not a form field, and a
// kiosk on-screen keyboard makes anything longer tedious to type anyway.
const MAX_NAME_LEN = 20

// How long to wait after the last keystroke before checking the name against
// the board - checking on every keystroke would fire a request per letter
// typed, for a check that only matters once someone stops typing.
const NAME_CHECK_DEBOUNCE_MS = 300

const MEDALS = ['🥇', '🥈', '🥉']

/** Same identity rule as the backend's _name_key (main.py) - case and
 * whitespace shouldn't make "Alice" and " alice " count as different
 * people, in either direction: two different players colliding, or one
 * player's own name failing to match itself. */
function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function formatWhen(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const time = `${hours}:${minutes} ${ampm}`
  if (sameDay) return time
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/** The leaderboard column shown both on the idle screen (attract mode, while
 * nobody's playing) and the results screen after a round. A single
 * component so medal styling, the "this is you" highlight and the timestamp
 * format can't drift between the two places it appears.
 *
 * `ownName`, when given, highlights the matching row - case/whitespace
 * -insensitively, same identity rule the backend uses (see main.py's
 * _name_key) so it lines up with which entry the backend actually just
 * updated. */
function LeaderboardList({
  entries,
  ownName,
}: {
  entries: Challenge67LeaderboardEntry[]
  ownName?: string
}) {
  if (entries.length === 0) return null
  const ownKey = ownName?.trim().toLowerCase()
  return (
    <div tw='text-ink text-lg flex flex-col gap-1 min-w-[320px] w-full border-t border-edge pt-4 mt-1'>
      <span tw='text-xs text-ink-muted uppercase tracking-widest mb-1'>
        Leaderboard
      </span>
      {entries.slice(0, 10).map((entry, i) => {
        const isOwn = !!ownKey && entry.name.trim().toLowerCase() === ownKey
        return (
          <div
            key={entry.name}
            tw='flex justify-between items-baseline gap-6 rounded-lg px-2 py-0.5'
            css={isOwn && tw`bg-accent bg-opacity-25`}
          >
            <span tw='flex gap-3 truncate'>
              <span tw='w-6 text-ink-muted'>{MEDALS[i] ?? `#${i + 1}`}</span>
              <span tw='truncate'>{entry.name}</span>
            </span>
            <span tw='flex gap-3 items-baseline flex-shrink-0'>
              <span tw='text-xs text-ink-muted'>{formatWhen(entry.ts)}</span>
              <span tw='font-semibold'>{entry.score}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** One card, centred over the live feed.
 *
 * Each screen used to be a STACK of separate black 50%-opacity boxes - a
 * title box, an instructions box, a score box, a rank box - floating with
 * gaps between them. That reads as debug overlay rather than product, and it
 * shared nothing with the palette the rest of the app uses. One panel, on the
 * shared tokens (tailwind.config.js), with the content spaced inside it.
 *
 * Slightly translucent so the person can still see themselves behind it,
 * which is the point of a photo booth - but far more opaque than the old
 * boxes, so text stays readable against a moving camera feed. */
function Panel({ children }: { children: any }) {
  return (
    <div tw='bg-surface bg-opacity-95 border border-edge rounded-2xl shadow-2xl px-10 py-8 flex flex-col items-center gap-5 max-w-[90vw]'>
      {children}
    </div>
  )
}

/** A readout floating over the feed during play - deliberately NOT a panel.
 * While the round is running the video is the thing to look at, so the timer
 * and the count stay as two small pills at the edges rather than a card in
 * the middle of the shot. */
function Readout({ children, big }: { children: any; big?: boolean }) {
  return (
    <div
      tw='bg-surface bg-opacity-80 border border-edge rounded-2xl text-ink font-bold'
      css={big ? tw`text-8xl px-14 py-10` : tw`text-2xl px-6 py-3 font-semibold`}
    >
      {children}
    </div>
  )
}

/** Full-screen overlay for 67 Mode, rendered by HUD.tsx in place of its
 * normal ready-state content (camera button/AnimPicker) when
 * challenge67Enabled is on - see store.ts's challenge67Game for why the
 * actual timer/rep-counting logic lives in Display.tsx's ticker instead of
 * here: this component is a pure reader of that shared state, plus the
 * "start"/"begin" triggers that drive phase forward. */
export default function Challenge67UI() {
  const game = useStore(challenge67Game)

  // The leaderboard shown wherever it's displayed - the idle screen and the
  // results screen (see the 'waiting'/'finished' cases below) - kept live
  // for as long as this component is mounted, not fetched once per screen,
  // so an edit made through Settings' admin editor (Challenge67LeaderboardEditor)
  // or anyone else's round finishing shows up immediately on whichever of
  // those two screens happens to be up, not just next time it mounts.
  const [liveBoard, setLiveBoard] = useState<Challenge67LeaderboardEntry[]>([])

  // Seeds it once on mount; the subscription and the submit fold-in below
  // keep it current after that.
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendHttpUrl()}/challenge67/leaderboard`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setLiveBoard(data.top ?? []) })
      .catch((e) => console.warn('Failed to load 67 Mode leaderboard:', e))
    return () => { cancelled = true }
  }, [])

  // main.py broadcasts the current top 10 on this topic after every submit
  // AND every admin save (see _broadcast_challenge67_leaderboard) - the same
  // rosbridge-style WS niceRos.ts already uses for pose/hand data, just a
  // topic of its own. Subscribing here is what makes an edit in Settings
  // show up without anyone needing to leave and re-enter a screen.
  const niceROS = useNiceROSState()
  useEffect(() => {
    let unsub: (() => void) | undefined
    niceROS.subscribeTopic('/challenge67_leaderboard_out', (msg: any) => {
      setLiveBoard(msg.top ?? [])
    }).then((u: () => void) => { unsub = u })
    return () => unsub?.()
  }, [niceROS])

  // This round's OWN submit response is folded in directly too, rather than
  // relying solely on the broadcast above - the broadcast is a separate,
  // best-effort round trip that could in principle be dropped or arrive
  // late, whereas the submit's own response is guaranteed to arrive with
  // this round's write already applied. Without this, a separate fetch
  // timed to the 'finished' transition used to race the POST that saves the
  // score and often won, showing the board as it looked BEFORE this round's
  // score was written - so even a chart-topping run never appeared at #1.
  useEffect(() => {
    if (game.lastResult) setLiveBoard(game.lastResult.top)
  }, [game.lastResult])

  // Local, not on the shared atom: keystrokes here don't need to be visible
  // to Display.tsx's ticker (nothing time-based happens during 'naming'), so
  // routing every character through the global store would just be needless
  // churn. Pre-filled from the last confirmed name so a repeat player
  // doesn't have to retype it.
  const [nameInput, setNameInput] = useState(game.playerName)

  // Whether nameInput is free to use, per the backend's board - null while
  // unchecked/checking, so the Begin button can tell "haven't confirmed yet"
  // apart from "confirmed taken". See main.py's challenge67_check_name_handler
  // for why this is a live check against the board rather than a client-side
  // guess: the board is the only copy of who's already played.
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null)
  const checkSeq = useRef(0)

  useEffect(() => {
    const trimmed = nameInput.trim()
    if (!trimmed) { setNameAvailable(null); return }

    // The name THIS session already confirmed is not a collision to check
    // for, even though it IS on the board - it's this same player's own
    // entry. Without this, "Play" (which pre-fills the field with exactly
    // this name - see start() below) always failed the check the instant it
    // loaded, since the player's own round had just put that name on the
    // board. Retry never hit this at all (it skips 'naming' entirely), which
    // is why the bug only showed up going through Play, and why re-typing a
    // fresh name after a refresh "worked" - a reload clears playerName, so
    // there was nothing left to collide with.
    if (game.playerName && sameName(trimmed, game.playerName)) {
      setNameAvailable(true)
      return
    }

    setNameAvailable(null)
    const seq = ++checkSeq.current
    const timer = setTimeout(() => {
      fetch(`${getBackendHttpUrl()}/challenge67/check_name?name=${encodeURIComponent(trimmed)}`)
        .then((res) => res.json())
        // Only the most recent check may apply its result - a slower
        // earlier request landing after a faster later one would otherwise
        // flash the wrong verdict for whatever's currently typed.
        .then((data) => { if (checkSeq.current === seq) setNameAvailable(!!data.available) })
        .catch((e) => console.warn('Failed to check 67 Mode name:', e))
    }, NAME_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [nameInput, game.playerName])

  const start = () => {
    if (game.phase !== 'waiting' && game.phase !== 'finished') return
    setNameInput(game.playerName)
    challenge67Game.set({ ...challenge67Game.get(), phase: 'naming', timeLeft: 0, reps: 0 })
  }

  // Same destination as begin() (phase -> 'countdown'), skipping 'naming'
  // entirely - the whole point is going again as the same player without
  // retyping a name that's already sitting on the shared atom from last
  // round. That reuse is also why this never needs a name-availability
  // check: the name is already confirmed and already on the board under
  // this player, so the backend raises their existing entry instead of
  // rejecting it - see main.py's challenge67_submit_handler. lastResult is
  // cleared for the same reason begin()'s route through 'naming' ->
  // 'countdown' -> 'playing' ends up clearing it (via the 'finished'
  // transition in Display.tsx's ticker): without it, a round ending early
  // for some reason would flash the PREVIOUS round's score/rank/leaderboard
  // instead of nothing.
  const retry = () => {
    if (game.phase !== 'finished') return
    challenge67Game.set({
      ...challenge67Game.get(),
      phase: 'countdown',
      timeLeft: 0,
      reps: 0,
      lastResult: undefined,
    })
  }

  const canBegin = game.phase === 'naming' && nameAvailable === true

  const begin = () => {
    if (!canBegin) return
    const name = nameInput.trim().slice(0, MAX_NAME_LEN)
    challenge67Game.set({ ...challenge67Game.get(), phase: 'countdown', playerName: name })
  }

  switch (game.phase) {
    case 'waiting':
      return (
        <div tw='inset-0 fixed flex items-center justify-center'>
          <Panel>
            <h1 tw='font-display text-ink text-6xl font-semibold tracking-wide uppercase'>67 Mode</h1>
            <p tw='text-ink-dim text-xl'>
              67 as fast as you can for 20 seconds
            </p>
            <KeybindBtn
              keyCode='PageUp'
              onClick={start}
              tw='text-2xl px-10 py-4 bg-accent hover:bg-accent-hover rounded-xl'
            >
              Start
            </KeybindBtn>
            <LeaderboardList entries={liveBoard} />
          </Panel>
        </div>
      )
    case 'naming': {
      // Distinguishing "still typing"/"checking" from "confirmed taken" so
      // the field doesn't flash red on every keystroke before a check has
      // even landed.
      const trimmed = nameInput.trim()
      const showTaken = trimmed.length > 0 && nameAvailable === false
      return (
        <div tw='inset-0 fixed flex items-center justify-center'>
          <Panel>
            <h1 tw='font-display text-ink text-4xl font-semibold tracking-wide uppercase'>Enter your name</h1>
            <div tw='flex flex-col items-center gap-2'>
              <input
                autoFocus
                value={nameInput}
                onChange={(e) => setNameInput((e.target as HTMLInputElement).value.slice(0, MAX_NAME_LEN))}
                onKeyDown={(e) => { if (e.key === 'Enter') begin() }}
                maxLength={MAX_NAME_LEN}
                tw='bg-surface-sunken text-ink text-2xl rounded-xl px-6 py-3 w-96 text-center outline-none border-2 border-edge focus:border-accent'
                css={showTaken && tw`border-red-500 focus:border-red-500`}
              />
              {/* Reserved height (not conditionally rendered) so the Begin
                  button below doesn't jump up and down as this appears. */}
              <div tw='text-red-400 text-sm h-5'>
                {showTaken && 'That name is already taken - try another'}
              </div>
            </div>
            <KeybindBtn
              keyCode='PageUp'
              onClick={begin}
              tw='text-2xl px-10 py-4 bg-accent hover:bg-accent-hover rounded-xl'
              disabled={!canBegin}
            >
              Begin
            </KeybindBtn>
          </Panel>
        </div>
      )
    }
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
          <Readout>{Math.max(0, Math.ceil(game.timeLeft))}s left</Readout>
          <Readout big>{game.reps}</Readout>
        </div>
      )
    case 'finished':
      return (
        <div tw='inset-0 fixed flex items-center justify-center'>
          <Panel>
            <span tw='text-ink-dim text-2xl'>{game.playerName}</span>
            <div tw='flex flex-col items-center'>
              <span tw='text-ink-muted text-sm uppercase tracking-widest'>Score</span>
              <span tw='text-ink text-7xl font-bold leading-none'>
                {game.lastResult?.score ?? game.reps}
              </span>
            </div>
          {game.lastResult && (
            <div tw='text-ink text-xl flex flex-col items-center gap-1'>
              <span>Rank {game.lastResult.rank} / {game.lastResult.total}</span>
              {/* Only one of these shows: a new best replaced what was on the
                  board (nothing more to say), while a round that didn't beat
                  it left the OLD score standing - worth surfacing, since
                  "Score: 12" above next to "Rank 1" would otherwise look like
                  a bug rather than an old personal best still holding rank. */}
              {game.lastResult.isNewBest ? (
                <span tw='text-yellow-400 font-semibold'>New personal best!</span>
              ) : (
                <span tw='text-ink-muted'>Your best: {game.lastResult.best}</span>
              )}
            </div>
          )}
          <LeaderboardList entries={liveBoard} ownName={game.playerName} />
          <div tw='flex flex-row gap-3 pt-1'>
            <KeybindBtn
              keyCode='PageUp'
              onClick={start}
              tw='text-xl px-8 py-3 bg-accent hover:bg-accent-hover rounded-xl'
            >
              Play
            </KeybindBtn>
            {/* Not PageDown: HUD.tsx binds that globally (cycling a debug
                pose index), gated on ITS OWN `state`, which stays 'ready'
                the whole time 67 Mode is active - 67 Mode is an early
                return in HUD's render, not a full component swap, so that
                keybind is still live underneath this screen. KeyR avoids
                the collision and doubles as a mnemonic. */}
            <KeybindBtn
              keyCode='KeyR'
              onClick={retry}
              tw='text-xl px-8 py-3 bg-surface-raised hover:bg-edge-strong border border-edge rounded-xl'
            >
              Retry
            </KeybindBtn>
            </div>
          </Panel>
        </div>
      )
  }
}
