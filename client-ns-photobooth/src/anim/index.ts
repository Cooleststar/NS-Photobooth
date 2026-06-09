import { KalmanFilterOpts } from 'kalmanjs'

export interface CommonAnimOpts {
  /** duration of fading animation */
  durationFade?: number
  /** duration to wait for redetection when lost */
  durationRetrack?: number
  /** option for the Kalman filters */
  kalman?: KalmanFilterOpts
  /** additional size multiplier */
  sizeFactor?: number
  /** x offset relative to anim size */
  xOffset?: number
  /** y offset relative to anim size */
  yOffset?: number
  /** whether anim should be flipped */
  flip?: boolean
}

export const defaultAnimOpts: Readonly<Required<CommonAnimOpts>> = {
  durationFade: parseFloat(import.meta.env.VITE_ANIM_FADE),
  durationRetrack: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
  kalman: {
    R: 0.01,
    Q: 3,
  },
  sizeFactor: 1,
  xOffset: 0,
  yOffset: 0,
  flip: false,
}

export type LocationTarget = {
  x: number
  y: number
  size: number
  angle: number
}
