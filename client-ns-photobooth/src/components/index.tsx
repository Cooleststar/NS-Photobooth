import tw from 'twin.macro'

// On the shared tokens (tailwind.config.js) rather than stock Tailwind
// blues, so every button in the app - this is the base all of them build
// on - matches the surfaces around it.
export const Btn = tw.button`rounded-lg bg-accent hover:bg-accent-hover text-ink px-4 py-2 text-xl transition-colors disabled:(bg-surface-raised text-ink-muted hover:bg-surface-raised pointer-events-none)`
export * from './AnimPicker'
export * from './OcFusionPicker'
export * from './TopControls'
export * from './Countdown'
export * from './KeybindBtn'
export * from './Modal'
export * from './Challenge67LeaderboardEditor'
