export * from '@pixi/constants'
export * from '@pixi/math'
export * from '@pixi/runner'
export * from '@pixi/settings'
export * from '@pixi/ticker'
import * as utils from '@pixi/utils'
export { utils }
export * from '@pixi/display'
export * from '@pixi/core'
export * from '@pixi/loaders'
export * from '@pixi/sprite'
export * from '@pixi/app'

// Renderer plugins
import { Renderer } from '@pixi/core'
import { BatchRenderer } from '@pixi/core'
Renderer.registerPlugin('batch', BatchRenderer)

// Application plugins
import { Application } from '@pixi/app'
import { AppLoaderPlugin, LoaderResource } from '@pixi/loaders'
Application.registerPlugin(AppLoaderPlugin)
import { TickerPlugin } from '@pixi/ticker'
Application.registerPlugin(TickerPlugin)

// Additional plugins

// https://pixijs.io/gif/docs/index.html
import { Loader } from '@pixi/loaders'
import { AnimatedGIFLoader } from '@pixi/gif'
export * as gif from '@pixi/gif'
Loader.registerPlugin(AnimatedGIFLoader)

// Settings
import { settings } from '@pixi/settings'
import { MIPMAP_MODES, MSAA_QUALITY } from '@pixi/constants'
settings.MIPMAP_TEXTURES = MIPMAP_MODES.ON
settings.FILTER_MULTISAMPLE = MSAA_QUALITY.HIGH
settings.STRICT_TEXTURE_CACHE = true
settings.ROUND_PIXELS = true
settings.RENDER_OPTIONS = {
  // have to fill in all options...
  antialias: true,
  autoDensity: false,
  backgroundAlpha: 1,
  backgroundColor: 0,
  clearBeforeRender: false,
  height: 720,
  legacy: false,
  // needed for toDataURL on canvas to get picture
  preserveDrawingBuffer: true,
  useContextAlpha: false,
  view: null as any,
  width: 1280,
}

import { textureCache } from './store'
/** NOTE: Must call loader.load() else it will block indefinitely! Will also block indefinitely if it never loads... */
export function ensureLoaded(
  loader: Loader,
  url: string,
  timeout: number = 60000,
) {
  const asset = textureCache.get()[url]
  if (asset === undefined) {
    // prevent duplicate load requests, which PIXI will throw error for some reason
    textureCache.setKey(url, 'queued' as any)
    loader.add(url, (res) => textureCache.setKey(url, res))
  }

  return new Promise<LoaderResource>((cb, err) => {
    const unsubscribe = textureCache.subscribe((cache, _) => {
      const asset = cache[url]
      if (asset && asset !== ('queued' as any)) {
        // not sure if not unsubbing causes a leak
        // but i get a hard to resolve error if i unsubscribe
        // unsubscribe()
        cb(asset)
      }
    })

    setTimeout(() => {
      unsubscribe()
      err(`${url} loading timed out in ${timeout}ms`)
    }, timeout)
  })
}
