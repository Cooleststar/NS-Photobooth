import { ComponentProps, useState } from 'react'
// Not 'react-dom' - nothing in this project actually installs react or
// react-dom (see package.json: only 'preact', plus '@types/react' purely for
// typing the 'react' import alias @preact/preset-vite resolves at build
// time). preact/compat is the real package providing createPortal here, and
// TS can only resolve types from a package that's actually installed.
import { createPortal } from 'preact/compat'
import tw, { css } from 'twin.macro'

// The one dialog look. There used to be a second, 'classic': a white card
// inside a bold 4px red border, which was the DEFAULT while every call site
// had already opted into this one - so it rendered nowhere and only made
// dialogs look like they might not match. Removed with the variant prop.
//
// Surfaces and text come from the shared tokens (tailwind.config.js), the
// same ones HUD and Settings use, so a dialog reads as part of the app
// rather than an approximation of it. A plain border and soft shadow is what
// makes it a card rather than a warning box.
const modalStyle = css`
  ${tw`relative font-sans text-ink bg-surface flex-grow flex flex-col items-center gap-6 p-8 max-w-3xl overflow-y-auto max-h-full rounded-2xl shadow-2xl border border-edge`}
  > h2 {
    ${tw`text-2xl font-bold text-center self-stretch text-ink`}
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
}

export function Modal({
  onDismiss = () => {},
  onClick,
  locked = false,
  hidden = false,
  wide = false,
  fullscreen = false,
  children,
  ...props
}: ModalProps) {
  const [shown, setShown] = useState(true)

  const handler = () => {
    if (!(onDismiss() === false) && !locked) setShown(false)
  }

  // Portalled straight to <body> rather than rendered where the component
  // tree happens to put it. `fixed` is only viewport-relative when nothing
  // between here and <body> applies a transform - anything that does (e.g.
  // Settings.tsx's sliding sidebar, which is `transform`ed for its open/close
  // slide animation) becomes the containing block instead, and every "fixed,
  // centered" modal opened from inside it renders squeezed into that
  // ancestor's own box instead of centered on the screen. A portal makes
  // that impossible regardless of where a call site happens to live.
  return createPortal(
    <div
      tw='fixed inset-0 bg-black bg-opacity-70 p-10 flex justify-center items-center'
      onClick={handler}
      css={[(hidden || !shown) && tw`hidden`, fullscreen && tw`p-0`]}
    >
      <div
        css={[
          modalStyle,
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
            tw`top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full text-2xl text-ink-muted opacity-100 hover:(bg-surface-raised text-ink)`,
          ]}
          onClick={handler}
        >
          ×
        </button>
        {children}
      </div>
    </div>,
    document.body,
  )
}
