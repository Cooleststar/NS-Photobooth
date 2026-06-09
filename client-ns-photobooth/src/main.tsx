import { render } from 'preact'
import { Global } from '@emotion/react'
import tw, { css, GlobalStyles as BaseStyles } from 'twin.macro'

import App from './App'
import 'webrtc-adapter'

const GlobalStyles = css`
  body {
    ${tw`text-white`}
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
