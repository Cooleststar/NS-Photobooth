import { render } from 'preact'
import { Global } from '@emotion/react'
import tw, { css, GlobalStyles as BaseStyles } from 'twin.macro'

import App from './App'
import 'webrtc-adapter'
import oswaldUrl from './assets/fonts/Oswald-SemiBold.woff2'

const GlobalStyles = css`
  /* Imported through Vite rather than referenced by path, so the file is
     fingerprinted and copied into the build like any other asset. */
  @font-face {
    font-family: 'Oswald';
    font-style: normal;
    font-weight: 600;
    /* No swap: on a kiosk the file is local and instant, and swap would
       flash the fallback on every load for no benefit. */
    font-display: block;
    src: url(${oswaldUrl}) format('woff2');
  }

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
