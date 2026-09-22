import { useEffect, useRef, useState } from 'react'
import tw, { css } from 'twin.macro'
import { useStore } from '@nanostores/preact'
import Display from './Display'
import HUD from './HUD'
import { canvasSize } from '../store'
import { Modal } from '../components'

const displayStyle = css`
  ${tw`fixed inset-0 bg-black flex items-center justify-center`}
  > canvas {
    ${tw`max-w-full h-full object-contain`}
  }
`

export default function Booth() {
  const photographerRef = useRef<() => Promise<string>>()
  const { height, width } = useStore(canvasSize)
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    const handler = () => {
      setFocused(document.hasFocus())
    }
    window.addEventListener('blur', handler)
    window.addEventListener('focus', handler)
    return () => {
      window.removeEventListener('blur', handler)
      window.removeEventListener('focus', handler)
    }
  }, [])
  return (
    <>
      <Display
        css={displayStyle}
        height={height}
        width={width}
        photographerRef={photographerRef}
      />
      <HUD photographerRef={photographerRef} />
      <Modal locked hidden={focused}>
        <h2>Click this window to regain focus</h2>
      </Modal>
    </>
  )
}
