import { useStore } from '@nanostores/preact'
import { WritableAtom } from 'nanostores'

export interface ToggleProps {
  label: string
  boolVar: WritableAtom
}

export function Toggle({ label, boolVar }: ToggleProps) {
  const value = useStore(boolVar)
  return (
    <label>
      {`${label}: `}
      <input
        type='checkbox'
        checked={value}
        onClick={() => boolVar.set(!value)}
      />
    </label>
  )
}
