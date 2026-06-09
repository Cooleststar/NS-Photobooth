import tw from 'twin.macro'

export const Btn = tw.button`rounded bg-blue-700 hover:bg-blue-900 text-white p-2 text-xl disabled:(bg-gray-600 hover:bg-gray-600 pointer-events-none)`
export * from './Countdown'
export * from './KeybindBtn'
export * from './Modal'
export * from './ResolutionInput'
export * from './Toggle'
