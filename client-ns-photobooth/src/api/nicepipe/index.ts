import { NormalizedLandmarkList } from '@mediapipe/drawing_utils'

type Point = [number, number]
/** box is tl, bl, br, tr */
export type PropDetection = [string, [Point, Point, Point, Point]]

/** x,y,z,conf as 8-bit ints, need to convert back to float */
export type PoseKeypoint = [number, number, number, number]

/** structure of analysis from nicepipe */
export type Analysis = {
  mp_pose?: {
    mask?: string
    pose?: NormalizedLandmarkList
  }
  kp?: PropDetection[]
  mmpose?: {
    [id: number]: PoseKeypoint[]
  }
}

export type FrameEvent = {
  img: string
  data: Analysis
}

/** TODO: nicepipe WebRTC API */
export type NiceRTCEvent = {}
