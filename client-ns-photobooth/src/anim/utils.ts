import KalmanFilter, { KalmanFilterOpts } from 'kalmanjs'

// PIXI doesn't have a lerp library :(

function normalize(x: number, start: number, end: number) {
  return Math.max(0, Math.min(1, (x - start) / (end - start)))
}

/** outputs value in range [0,1] depending on progress (linear) */
export function lerpLinear(x: number, start: number, end: number) {
  return normalize(x, start, end)
}

/** outputs value in range [0,1] depending on progress (ease-out) */
export function lerpEO(x: number, start: number, end: number, pow = 1.5) {
  return 1 - (1 - normalize(x, start, end)) ** pow
}

/** convenience to apply kalman filtering to any map of numeric measurements */
export function createKFilter(props: KalmanFilterOpts) {
  const obj: Record<string, KalmanFilter> = {}
  return <T extends Record<string, number>>(values: T): T =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => {
        if (obj[k] === undefined) obj[k] = new KalmanFilter(props)
        return [k, obj[k].filter(v)]
      }),
    ) as T
}
