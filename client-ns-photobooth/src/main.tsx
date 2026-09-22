import { render } from 'preact'
import { Global } from '@emotion/react'
import tw, { css, GlobalStyles as BaseStyles } from 'twin.macro'

import App from './App'
import 'webrtc-adapter'

const GlobalStyles = css`
  body {
    /* Was text-white only, leaving the page itself the browser default -
       a white flash before the first screen paints, and raw white behind
       anything that did not cover the viewport. Both come from the shared
       tokens now (tailwind.config.js). */
    ${tw`text-ink bg-surface-base`}
  }
`

render(
  <>
    <BaseStyles />
    <Global styles={GlobalStyles} />
    <App />
  </>,
  document.getElementById('app')!,
)
