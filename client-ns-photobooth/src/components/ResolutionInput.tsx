import { Dispatch, useRef } from 'react'
import { Btn } from '.'

type Resolution = {
  height: number
  width: number
}
interface ResolutionInputProps {
  resolutionHook: [Resolution, Dispatch<Resolution>]
  label?: string
}
export function ResolutionInput({
  resolutionHook,
  label,
}: ResolutionInputProps) {
  const [{ height, width }, setResolution] = resolutionHook
  const heightRef = useRef<HTMLInputElement>(null)
  const widthRef = useRef<HTMLInputElement>(null)

  const changeSize = () => {
    const hElem = heightRef.current
    const wElem = widthRef.current

    if (!hElem || !wElem) return

    setResolution({
      height: parseInt(hElem.value),
      width: parseInt(wElem.value),
    })
  }

  return (
    <label>
      {`${label ?? 'Size'}: `}
      <input
        ref={widthRef}
        tw='w-14 text-right'
        type='number'
        min={0}
        max={3840}
        value={width}
        placeholder='width'
      />{' '}
      ×{' '}
      <input
        ref={heightRef}
        tw='w-14 text-left'
        type='number'
        min={0}
        max={2160}
        value={height}
        placeholder='height'
      />
      <Btn tw='text-base inline p-1' onClick={changeSize}>
        Set
      </Btn>
    </label>
  )
}
