import { ComponentProps, useState } from 'react'
import tw, { css } from 'twin.macro'

const modalStyle = css`
  ${tw`relative text-black bg-white flex-grow flex flex-col items-center gap-5 p-5 max-w-5xl overflow-y-auto max-h-full rounded-2xl shadow-lg border-red-600 border-4`}
  > h2 {
    ${tw`text-3xl text-center self-stretch`}
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

  return (
    <div
      tw='fixed inset-0 bg-black bg-opacity-70 p-10 flex justify-center items-center'
      onClick={handler}
      css={[(hidden || !shown) && tw`hidden`, fullscreen && tw`p-0`]}
    >
      <div
        css={[
          modalStyle,
          wide && tw`max-w-7xl`,
          fullscreen && tw`max-w-none w-full h-full rounded-none border-0`,
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
          css={locked && tw`hidden`}
          onClick={handler}
        >
          x
        </button>
        {children}
      </div>
    </div>
  )
}
