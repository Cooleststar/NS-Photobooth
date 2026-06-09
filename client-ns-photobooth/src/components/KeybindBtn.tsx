import { ComponentProps, useEffect, useRef } from 'react'
import { Btn } from '.'

/** triggers function when specific mouse button is clicked anywhere within window */
export function useKeybind(keyCode: string, onClick: () => any) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // TODO: on linux certain keys like R already binded
      // weird D doesnt seem to do anything unless caplocked

      // check if user is not in input field
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      )
        return
      if (e.code === keyCode) {
        onClick()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [keyCode, onClick])
}

export interface KeybindBtnProps extends ComponentProps<typeof Btn> {
  keyCode: string
}

/** button that triggers when special mouse button is used */
export function KeybindBtn({ keyCode, ...props }: KeybindBtnProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  useKeybind(keyCode, () => buttonRef.current && buttonRef.current.click())

  return <Btn ref={buttonRef} {...props}></Btn>
}
