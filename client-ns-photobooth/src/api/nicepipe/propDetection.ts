import { LocationTarget } from '../../anim'

export type Point = [number, number]
/** box is tl, bl, br, tr */
export type PolyBox = [Point, Point, Point, Point]
/** name, bounding box */
export type PropDetection = [string, PolyBox]
/** unnormalize coordinates of box */
export function convertPropDet(
  [name, box]: PropDetection,
  height: number,
  width: number,
): PropDetection {
  box = box.map((pt) => [pt[0] * width, pt[1] * height]) as PolyBox
  return [name, box]
}

/** returns undefined if box deemed "gitchy" using standard deviation of measurements */
export function calculatePropTarget(
  [_, [...box]]: PropDetection,
  diag_thres = 40,
  angle_thres = 12,
) {
  // Too lazy to calculate rectangle & rotation so eat this
  // const [pt1, pt2, pt3, pt4] = box
  // average of all pts = center
  const x = box.reduce((s, p) => s + p[0], 0) / 4
  const y = box.reduce((s, p) => s + p[1], 0) / 4

  // dist from center to any pt is always 1/2 of diagonal (assuming box isnt skewed)
  // from this we can find the box size!
  // average of all "diagonals" to find approx diagonal length
  const diags = box.map((p) => 2 * ((p[0] - x) ** 2 + (p[1] - y) ** 2) ** 0.5)
  const diag = diags.reduce((s, d) => s + d) / 4
  if (diag < 1) return undefined
  const diag_sd = Math.sqrt(diags.reduce((s, d) => s + (d - diag) ** 2, 0) / 4)
  if (diag_sd > diag_thres) return undefined

  const agls = box.map((b, i, arr) => {
    const a = arr.at(i - 1)!
    const ratio =
      i % 2 === 1
        ? (b[0] - a[0]) / (a[1] - b[1])
        : (a[1] - b[1]) / (a[0] - b[0])
    return (Math.atan(ratio) * 180) / Math.PI
  })
  let agl = agls.reduce((s, a) => s + a) / 4
  if (Number.isNaN(agl)) return undefined
  const agl_sd = Math.sqrt(agls.reduce((s, a) => s + (a - agl) ** 2, 0) / 4)
  if (agl_sd > angle_thres) return undefined

  // TODO: filter abnormally large or small boxes
  // handle if box is upside down (by now box assumed to be nice)
  if (box[1][1] < box[0][1]) agl = 180 + agl
  return {
    x,
    y,
    size: diag,
    angle: -agl,
  } as LocationTarget
}

/** calculates a valid target location from list of dets aka hardcoded to one instance */
export function createTargetCalculator(height: number, width: number) {
  return (name: string, dets: PropDetection[]) => {
    return dets
      .map(
        (d) =>
          d[0] === name &&
          calculatePropTarget(convertPropDet(d, height, width)),
      )
      .filter((o) => o)[0] as LocationTarget | undefined
  }
}
