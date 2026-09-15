import { ComponentProps, useState } from 'react'
import tw, { css } from 'twin.macro'

// The original card look — bold red border, square-ish shadow. Kept as the
// default so every existing call site (the focus-lock lock screen, the
// uploading spinner, the error dialog) stays exactly as it was; only the
// confirm screen opts into 'modern' below.
const classicModalStyle = css`
  ${tw`relative text-black bg-white flex-grow flex flex-col items-center gap-5 p-5 max-w-5xl overflow-y-auto max-h-full rounded-2xl shadow-lg border-red-600 border-4`}
  > h2 {
    ${tw`text-3xl text-center self-stretch`}
  }
`

// Same dark-theme tokens as the gallery app (gallery/src/style.css's
// :root[data-theme='dark']: --bg-surface #1e222a, --border #2c313b,
// --text-primary #f3f4f6) rather than generic Tailwind grays, so this reads
// as the same surface rather than an approximation of it. A plain border +
// soft shadow instead of a bold colored one is what makes it read as a
// modern card rather than a warning/boxed-form dialog either way.
//
// font-sans is Tailwind's system-ui stack (ui-sans-serif, system-ui,
// -apple-system, "Segoe UI", Roboto, ...) - the same family the gallery app
// sets on its own <body> (style.css: `font-family: system-ui, ...`). Nothing
// in this app sets a font anywhere else, so every 'modern' dialog was
// otherwise falling through to the browser's default serif.
const modernModalStyle = css`
  ${tw`relative font-sans text-[#f3f4f6] bg-[#1e222a] flex-grow flex flex-col items-center gap-6 p-8 max-w-3xl overflow-y-auto max-h-full rounded-2xl shadow-2xl border border-[#2c313b]`}
  > h2 {
    ${tw`text-2xl font-bold text-center self-stretch text-[#f3f4f6]`}
  }
`

export interface ModalProps extends ComponentProps<'div'> {
  /** return false to prevent modal from being dismissed */
  onDismiss?: () => boolean | void
  /** set as true to prevent modal from being dimissable */
  locked?: boolean
  hidden?: boolean
  /** use a larger max-width than the default (e.g. for the photo gallery) */
  wide?: boolean
  /** fill the entire viewport instead of a centered bordered card */
  fullscreen?: boolean
  /** 'classic' (default) is the original bold-red-border card, used
   * everywhere already. 'modern' is the gallery app's card language (plain
   * border, soft shadow, neutral/blue palette) - opt in per call site rather
   * than changing the shared default, so switching one dialog's look never
   * silently changes another's. */
  variant?: 'classic' | 'modern'
}

export function Modal({
  onDismiss = () => {},
  onClick,
  locked = false,
  hidden = false,
  wide = false,
  fullscreen = false,
  variant = 'classic',
  children,
  ...props
}: ModalProps) {
  const [shown, setShown] = useState(true)

  const handler = () => {
    if (!(onDismiss() === false) && !locked) setShown(false)
  }

  return (
    <div
      tw='fixed inset-0 bg-black bg-opacity-70 p-10 flex justify-center items-center'
      onClick={handler}
      css={[(hidden || !shown) && tw`hidden`, fullscreen && tw`p-0`]}
    >
      <div
        css={[
          variant === 'modern' ? modernModalStyle : classicModalStyle,
          wide && tw`max-w-7xl`,
          fullscreen && tw`max-w-none w-full h-full rounded-none border-0 bg-gray-200`,
        ]}
        {...props}
        onClick={(e) => {
          e.stopPropagation()
          // @ts-ignore
          onClick && onClick(e)
        }}
      >
        <button
          tw='absolute top-0 right-2 text-3xl opacity-50 hover:opacity-100'
          css={[
            locked && tw`hidden`,
            variant === 'modern' &&
              tw`top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full text-2xl text-[#98a1b0] opacity-100 hover:(bg-[#272c35] text-[#f3f4f6])`,
          ]}
          onClick={handler}
        >
          x
        </button>
        {children}
      </div>
    </div>
  )
}
