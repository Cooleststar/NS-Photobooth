import {
  NormalizedLandmark,
  NormalizedLandmarkList,
} from '@mediapipe/drawing_utils'
import { PoseKeypoint } from '.'

/** note the coordinates are implicitly clipped... */
function convert8bitKeypoint(kp: PoseKeypoint): NormalizedLandmark {
  return {
    x: kp[0] / 255,
    y: kp[1] / 255,
    z: kp[2] / 255,
    visibility: kp[3] / 255,
  }
}

export function convert2mpPose(pose: PoseKeypoint[]): NormalizedLandmarkList {
  return pose.map(convert8bitKeypoint)
}
