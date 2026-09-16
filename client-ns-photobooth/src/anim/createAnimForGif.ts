import { Analysis } from '../api/nicepipe'
import * as PIXI from '../pixi'
import { GifOption } from '../store'

import { createBatAnim } from './bat'
import { createBatEarsAnim } from './batears'
import { createBoxGloveAnim } from './boxglove'
import { createClownWigNoseAnim } from './clownwignose'
import { createDroneAnim } from './drone'
import { createGlobeAnim } from './globe'
import { createMustacheAnim } from './mustache'
import { createOCFusionAnim } from './ocfusion'
import { createOwlAnim } from './owl'
import { createPigNoseAnim } from './pignose'
import { createScubaAnim } from './scuba'
import { createSixSevenAnim } from './sixseven'
import { createSunglassesAnim } from './sunglasses'

/** Margins the feed is inset by, passed to the characters that need to clamp
 * themselves to the visible video rather than the whole canvas. */
export interface MarginOpts {
  mx: number
  mt: number
  mb: number
}

/** Builds the PIXI display object + per-frame update function for one
 * selected character, or null for an option with no animation of its own
 * ('none', and 'ocfusion' when it's driven by its own standalone picker).
 *
 * Lives here rather than inside Display.tsx's setup effect because it is a
 * pure dispatch table - it needs the app, the margins and the latest raw
 * analysis, and nothing else from that effect's ~600 lines of surrounding
 * lifecycle state. Keeping it out also keeps every character import out of
 * Display.tsx, which otherwise imported all thirteen purely to feed this
 * one function.
 *
 * `rawRef` rather than a plain hand list: the hand-driven characters need
 * whatever the LATEST frame holds when their update runs, not whatever was
 * current when they were built. */
export async function createAnimForGif(
  option: GifOption,
  app: PIXI.Application,
  marginOpts: MarginOpts,
  rawRef: { current: Analysis },
) {
  if (option === 'owl') {
    return await createOwlAnim(app)
  } else if (option === 'bat') {
    return await createBatAnim(app)
  } else if (option === 'globe') {
    return await createGlobeAnim(app, marginOpts)
  } else if (option === 'drone') {
    const [container, updateDrone] = await createDroneAnim(app, marginOpts)
    // Drone uses hand landmarks, not body pose — ignore the pose arg
    const wrappedUpdate = (_pose: any) => updateDrone(rawRef.current.hands ?? [])
    return [container, wrappedUpdate] as const
  } else if (option === 'scuba') {
    return await createScubaAnim(app, marginOpts)
  } else if (option === 'ocfusion') {
    // No longer hand-tracked (see ocfusion.ts) — reads its assigned person's
    // own face pose directly, same contract as pignose/etc.
    return await createOCFusionAnim(app)
  } else if (option === 'boxglove') {
    // Hand-tracked like drone/sixseven: one glove per closed fist, so the
    // animation owns all its slots and takes the raw hand list rather than a
    // per-person pose.
    const [container, updateGloves] = await createBoxGloveAnim(app)
    const wrappedUpdate = (_pose: any) => updateGloves(rawRef.current.hands ?? [])
    return [container, wrappedUpdate] as const
  } else if (option === 'sixseven') {
    const [container, updateSixSeven] = await createSixSevenAnim(app, marginOpts)
    // Same as the drone — driven by hand landmarks, not body pose
    const wrappedUpdate = (_pose: any) => updateSixSeven(rawRef.current.hands ?? [])
    return [container, wrappedUpdate] as const
  } else if (option === 'pignose') {
    return await createPigNoseAnim(app)
  } else if (option === 'batears') {
    return await createBatEarsAnim(app)
  } else if (option === 'clownwignose') {
    return await createClownWigNoseAnim(app)
  } else if (option === 'sunglasses') {
    return await createSunglassesAnim(app)
  } else if (option === 'mustache') {
    return await createMustacheAnim(app)
  }
  return null
}
