import { NormalizedLandmarkList } from '../landmarks'

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
  /** Palm's surface facing upward/skyward — a roughly horizontal outstretched
   * hand, like offering/presenting something on it. Used by drone.ts and
   * sixseven.ts. */
  palmSky: boolean
  /** Closed fist. Derived from WiLoR's predicted finger-joint rotations, not
   * from landmarks - those are all the bbox centre (see wilor_hands.py). */
  fist: boolean
  /** How closed the hand is, in radians of mean joint flexion. Sent alongside
   * `fist` so the threshold can be judged from live values. */
  curl: number
  /** Rotation, in radians, laying a hand-worn prop along the fingers. Screen
   * space, measured from +x with y growing downward - i.e. straight into
   * PIXI's sprite.rotation.
   *
   * When angleSrc is 'mp' this is measured wrist-to-knuckles from real
   * landmarks; when 'wilor' it is derived from the wrist rotation matrix. */
  angle: number
  angleSrc: 'mp' | 'wilor'
  /** Hand box size as a fraction of the frame, for scaling a worn prop with
   * how close the hand is. */
  w: number
  h: number
  /** Detector confidence. */
  conf: number
  /** Where `label` came from. 'mp' is MediaPipe's handedness classifier, which
   * predicts left/right directly and reports 0.98+ confidence on this camera.
   * 'wilor' is its own detector's class, which is unreliable - it reported
   * three hands in one frame as all "Left" - and is only used when MediaPipe
   * found no matching hand. Consumers that care about handedness should check
   * this before trusting `label`. */
  labelSrc: 'mp' | 'wilor'
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
