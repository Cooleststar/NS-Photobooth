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
  /** Upright hand, palm facing the camera (e.g. a "stop" gesture) */
  palmUp: boolean
  /** Palm's surface facing upward/skyward — a roughly horizontal outstretched
   * hand, like offering/presenting something on it. Distinct from palmUp. */
  palmSky: boolean
}

/** One decoded QR code (QR mode). x/y are its center — normalized 0-1 on
 * rawRef (raw camera-frame coordinates), or remapped screen-space pixels on
 * dataRef (see the qrCodes remap in Display.tsx's createReceivingCtx,
 * mirroring how pose/prop detections are remapped there). */
export type QrCodeDetection = { payload: string; x: number; y: number }

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
  /** Every QR code currently visible in-frame (QR mode only) */
  qrCodes?: QrCodeDetection[]
  /** performance.now() timestamp of the last /pose_out message received — used to
   * show a "delay" metric (how stale the detection data currently in use is) */
  lastUpdateTs?: number
}

export type FrameEvent = {
  img: string
  data: Analysis
}

/** TODO: nicepipe WebRTC API */
export type NiceRTCEvent = {}
