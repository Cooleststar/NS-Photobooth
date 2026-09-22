import { useEffect, useRef, useState } from 'react'
import tw from 'twin.macro'
import { Modal } from './Modal'
import { Challenge67LeaderboardEntry, getBackendHttpUrl } from '../store'

/** A fresh row has no ts yet - the backend fills one in on save (see
 * main.py's challenge67_admin_save_handler), but a real number is needed
 * here so the "Set" column has something to render before that round trip. */
function blankEntry(): Challenge67LeaderboardEntry {
  return { name: '', score: 0, ts: Date.now() / 1000 }
}

/** The unlock screen, then the entries table, for the same Modal - password
 * state lives in EditorModal rather than the table itself, since Save
 * resends it with every request (this backend has no session/token, just a
 * password check per call - see main.py's challenge67_admin_save_handler).
 *
 * Mounted only while the editor is open (see Challenge67LeaderboardEditor
 * below), so closing and reopening it always starts back at the password
 * screen - there's no "stay unlocked" state to accidentally leave behind. */
function EditorModal({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  // Defaults to visible: a kiosk touchscreen keyboard has no separate
  // "confirm password" step to catch a typo, and this isn't a password worth
  // shoulder-surfing over, so hiding it by default only adds a way to fail
  // silently. Kept toggleable in case the settings panel is ever shown on a
  // screen other people can see over your shoulder.
  const [showPassword, setShowPassword] = useState(true)
  const [unlocked, setUnlocked] = useState(false)
  const [entries, setEntries] = useState<Challenge67LeaderboardEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const unlock = async () => {
    if (busy || !password) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${getBackendHttpUrl()}/challenge67/admin/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.status === 401) { setError('Incorrect password'); return }
      if (!res.ok) { setError(await res.text()); return }
      const data = await res.json()
      setEntries(data.entries ?? [])
      setUnlocked(true)
    } catch (e) {
      setError('Could not reach the backend')
    } finally {
      setBusy(false)
    }
  }

  const patch = (i: number, next: Partial<Challenge67LeaderboardEntry>) =>
    setEntries((es) => es.map((e, j) => (j === i ? { ...e, ...next } : e)))
  const remove = (i: number) => setEntries((es) => es.filter((_, j) => j !== i))
  const add = () => setEntries((es) => [...es, blankEntry()])

  // Takes an explicit list rather than always reading `entries`, so
  // clearAll below can push an empty board without a setEntries+effect
  // round trip first - it saves exactly what it means to save.
  const save = async (toSave: Challenge67LeaderboardEntry[] = entries) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${getBackendHttpUrl()}/challenge67/admin/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, entries: toSave }),
      })
      if (res.status === 401) {
        // The password can't have changed mid-edit - this means the request
        // itself is wrong somehow - but re-locking rather than silently
        // retrying makes that visible instead of possibly looping.
        setError('Incorrect password')
        setUnlocked(false)
        return
      }
      if (!res.ok) { setError(await res.text()); return }
      const data = await res.json()
      // Reflects what the backend actually stored - sorted, deduped ts
      // filled in, and truncated to the same cap normal play respects - so
      // the table never shows something other than what's really on disk.
      setEntries(data.entries ?? [])
      if (data.truncated) {
        setError(`Saved - the list was trimmed to the top ${data.entries.length} entries.`)
      }
    } catch (e) {
      setError('Could not reach the backend')
    } finally {
      setBusy(false)
    }
  }

  // Two-tap guard against a stray tap wiping the whole board - this is
  // already behind the password screen, so it's a mis-tap safety net rather
  // than a permission check the way the editor's own unlock screen is.
  const [confirmingClear, setConfirmingClear] = useState(false)
  const clearArmTimer = useRef<number>()
  useEffect(() => () => window.clearTimeout(clearArmTimer.current), [])
  const clearAll = () => {
    if (busy) return
    if (!confirmingClear) {
      setConfirmingClear(true)
      clearArmTimer.current = window.setTimeout(() => setConfirmingClear(false), 3000)
      return
    }
    window.clearTimeout(clearArmTimer.current)
    setConfirmingClear(false)
    void save([])
  }

  if (!unlocked) {
    return (
      <Modal onDismiss={onClose}>
        <h2>67 Mode Leaderboard</h2>
        <div tw='flex flex-col gap-3 w-72'>
          <div tw='relative'>
            <input
              // On-screen keyboards (this is a kiosk) autocapitalize and
              // autocorrect by default, which can silently change what's
              // typed - e.g. capitalizing after the "@" as if it started a
              // new sentence. All four are turned off so what's on screen
              // (see the eye toggle below) is really what gets sent.
              type={showPassword ? 'text' : 'password'}
              autoFocus
              autoComplete='off'
              autoCapitalize='off'
              autoCorrect='off'
              spellCheck={false}
              value={password}
              onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') unlock() }}
              placeholder='Password'
              tw='w-full bg-surface-sunken border border-edge text-ink text-base pl-4 pr-10 py-2 rounded-lg text-center outline-none'
            />
            <button
              type='button'
              tabIndex={-1}
              onClick={() => setShowPassword((s) => !s)}
              title={showPassword ? 'Hide password' : 'Show password'}
              tw='absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink text-lg leading-none px-1'
            >
              {showPassword ? '🙈' : '👁️'}
            </button>
          </div>
          <button
            tw='bg-accent hover:bg-accent-hover disabled:opacity-50 text-ink text-sm py-2 rounded-lg'
            disabled={busy || !password}
            onClick={unlock}
          >
            {busy ? 'Checking…' : 'Unlock'}
          </button>
          {error && <span tw='text-red-400 text-sm text-center'>{error}</span>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal onDismiss={onClose} wide>
      <h2>67 Mode Leaderboard</h2>
      <div tw='flex flex-col gap-2 w-full max-h-[50vh] overflow-y-auto'>
        <div tw='flex gap-2 text-xs text-ink-muted uppercase tracking-wide px-1'>
          <span tw='flex-1'>Name</span>
          <span tw='w-20 text-center'>Score</span>
          <span tw='w-36'>Set</span>
          <span tw='w-6' />
        </div>
        {entries.length === 0 && (
          <span tw='text-ink-muted text-sm text-center py-4'>No entries yet.</span>
        )}
        {entries.map((entry, i) => (
          <div key={i} tw='flex gap-2 items-center'>
            <input
              value={entry.name}
              onChange={(e) => patch(i, { name: (e.target as HTMLInputElement).value })}
              tw='flex-1 min-w-0 bg-surface-sunken border border-edge text-ink text-sm px-2 py-1.5 rounded'
            />
            <input
              type='number'
              min={0}
              max={400}
              value={entry.score}
              onChange={(e) => patch(i, { score: parseInt((e.target as HTMLInputElement).value) || 0 })}
              tw='w-20 bg-surface-sunken border border-edge text-ink text-sm px-2 py-1.5 rounded text-center'
            />
            <span tw='w-36 text-xs text-ink-muted flex-shrink-0 truncate'>
              {new Date(entry.ts * 1000).toLocaleString()}
            </span>
            <button
              tw='w-6 text-red-400 hover:text-red-300 text-lg leading-none flex-shrink-0'
              onClick={() => remove(i)}
              title='Delete entry'
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div tw='flex gap-3 w-full'>
        <button
          tw='flex-1 bg-surface-raised hover:bg-edge-strong text-ink text-sm py-2 rounded-lg'
          onClick={add}
        >
          + Add entry
        </button>
        <button
          tw='flex-1 bg-accent hover:bg-accent-hover disabled:opacity-50 text-ink text-sm py-2 rounded-lg'
          disabled={busy}
          onClick={() => save()}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      <button
        tw='w-full bg-surface-raised hover:bg-red-900 disabled:opacity-50 text-red-400 hover:text-red-200 text-sm py-2 rounded-lg transition-colors'
        css={confirmingClear && tw`bg-red-600 text-ink hover:bg-red-700 hover:text-ink`}
        disabled={busy || entries.length === 0}
        onClick={clearAll}
      >
        {busy ? 'Clearing…' : confirmingClear ? 'Tap again to clear everything' : 'Clear leaderboard'}
      </button>
      {error && <span tw='text-red-400 text-sm text-center'>{error}</span>}
    </Modal>
  )
}

/** Settings button that opens the password-gated 67 Mode leaderboard editor.
 * Saving here updates challenge67_leaderboard.json directly and broadcasts
 * the change immediately (see main.py's challenge67_admin_save_handler), so
 * it shows up live on the idle screen and the results screen without either
 * needing a refresh - see Challenge67UI.tsx's leaderboard subscription. */
export function Challenge67LeaderboardEditor() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        tw='w-full text-sm py-2 px-3 bg-surface-raised hover:bg-surface-raised text-ink rounded-lg text-left transition-colors'
        onClick={() => setOpen(true)}
      >
        Edit Leaderboard…
      </button>
      {open && <EditorModal onClose={() => setOpen(false)} />}
    </>
  )
}
