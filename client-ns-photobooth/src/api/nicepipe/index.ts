import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'

type Point = [number, number]
/** box is tl, bl, br, tr */
export type PropDetection = [string, [Point, Point, Point, Point]]

/** x,y,z,conf as 8-bit ints, need to convert back to float */
export type PoseKeypoint = [number, number, number, number]

/** One detected hand from MediaPipe Hands (21 landmarks, normalized 0–1) */
export type HandData = {
  x: number[]
  y: number[]
  z: number[]
  label: 'Left' | 'Right'
  palmUp: boolean
}

/** structure of analysis from nicepipe */
export type Analysis = {
  mp_pose?: {
    mask?: string
    pose?: NormalizedLandmarkList
  }
  /** Real 33-point MediaPipe pose used for debug skeleton overlay */
  mp_debug_pose?: NormalizedLandmarkList
  kp?: PropDetection[]
  mmpose?: {
    [id: number]: PoseKeypoint[]
  }
  allPoses?: { [id: number]: NormalizedLandmarkList }
  hands?: HandData[]
}

export type FrameEvent = {
  img: string
  data: Analysis
}

/** TODO: nicepipe WebRTC API */
export type NiceRTCEvent = {}
