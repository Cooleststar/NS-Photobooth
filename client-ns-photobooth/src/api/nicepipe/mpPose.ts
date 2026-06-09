import {
  NormalizedLandmark,
  NormalizedLandmarkList,
} from '@mediapipe/drawing_utils'

/** converts normalizedLandmark to unnormalized coordinates */
export function convertPoint(
  point: NormalizedLandmark,
  height: number,
  width: number,
): NormalizedLandmark {
  return {
    x: (1 - point.x) * width,
    y: point.y * height,
    z: point.z,
    visibility: point.visibility,
  }
}

// TODO: should this function be even more pure?
// right now its the trigger for a very specific pose
/** calculate information about specific arm pose */
export function calculateArmFromPose(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
): [
  'left' | 'right' | undefined,
  { x: number; y: number; angle: number; length: number } | undefined,
] {
  // mediapipe will predict even pose outside of frame, so its either 0 or all the points
  // TODO: if points are scaled, check via visibility. out of frame WONT WORK
  if (pose.length == 0) return [undefined, undefined]
  pose = pose.map((point) => convertPoint(point, height, width))

  // left_elbow, right_elbow, left_wrist, right_wrist
  const le = pose[13],
    re = pose[14],
    lw = pose[15],
    rw = pose[16]

  // left arm angle & length
  const la = Math.atan((lw.y - le.y) / (lw.x - le.x))
  const ll = ((lw.y - le.y) ** 2 + (lw.x - le.x) ** 2) ** 0.5
  // right arm angle & length
  const ra = Math.atan((rw.y - re.y) / (rw.x - re.x))
  const rl = ((rw.y - re.y) ** 2 + (rw.x - re.x) ** 2) ** 0.5

  // left arm in frame & position
  if (
    le.visibility! > 0.5 &&
    lw.visibility! > 0.5 &&
    le.y > 0 &&
    le.y < height &&
    Math.abs(la) < 30 * (Math.PI / 180)
  )
    return ['left', { x: le.x, y: le.y, angle: la, length: ll }]
  // right arm in frame & position
  else if (
    re.visibility! > 0.5 &&
    rw.visibility! > 0.5 &&
    re.y > 0 &&
    re.y < height &&
    Math.abs(ra) < 30 * (Math.PI / 180)
  )
    return ['right', { x: re.x, y: re.y, angle: ra, length: rl }]
  return [undefined, undefined]
}
