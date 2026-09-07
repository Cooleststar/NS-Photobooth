/**
 * Pose landmark types.
 *
 * These were imported from the MediaPipe drawing-utils package for as long
 * as MediaPipe was the pose model. It has not been for some time - the backend runs YOLO26
 * for pose, ViTPose++ for keypoint refinement and WiLoR for hands - so the
 * package was left installed purely to supply two type aliases, and every
 * animation carried an import naming a library the project no longer uses.
 *
 * The shape is unchanged, so this is a rename rather than a migration. The
 * 33-landmark layout the backend emits is still MediaPipe's, because that is
 * the wire format the animations were written against; see _COCO_TO_MP in
 * backend/main.py, which maps YOLO's 17 COCO keypoints into it.
 */

/** One landmark in normalised [0,1] frame coordinates.
 *
 * `z` and `visibility` are optional because the backend leaves them off for
 * landmarks with no COCO equivalent - the 33-point layout has more points than
 * YOLO produces, and the unfilled ones come through as not visible. */
export interface NormalizedLandmark {
  x: number
  y: number
  z?: number
  visibility?: number
}

/** A whole pose: 33 landmarks in the MediaPipe ordering. */
export type NormalizedLandmarkList = NormalizedLandmark[]
