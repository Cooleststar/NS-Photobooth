/**
 * Functions to convert from niceROS's format to what this photobooth accepts
 */

import { useNiceROSState } from 'nice-ros-react'
import { AnyTopicMap, MSG } from 'nice-ros-sdk'
import { MutableRefObject, useEffect } from 'react'
import { NormalizedLandmark } from '@mediapipe/drawing_utils'
import { Analysis, HandData, PoseKeypoint } from './nicepipe'
import { Point } from './nicepipe/propDetection'

/** ImageMarker isn't part of nice-ros-sdk.MSG... Typing below is incomplete but sufficient */
interface ImageMarker {
  header: MSG.Header
  ns: string
  points: { x: number; y: number; z: number }[]
}

interface BackendTyping extends AnyTopicMap {
  '/pose_out': MSG.WholeBodyArray
  '/rect_out': {
    markers: ImageMarker[]
  }
}

// TODO: this is a interface adapter; its a hacky workaround. should just change
// downstream code to use new structure
export function useNiceROSAnalysis(dataRef: MutableRefObject<Analysis>) {
  const niceROS = useNiceROSState<BackendTyping>()

  useEffect(() => {
    const unsub1 = niceROS.subscribeTopic('/pose_out', (msg: any) => {
      const { poses, hands, mp_pose, qr_codes } = msg as {
        poses: { x: number[]; y: number[]; z: number[]; scores: number[]; track: { id: number } }[]
        hands?: { x: number[]; y: number[]; z: number[]; label: string; palm_up: boolean }[]
        mp_pose?: { x: number[]; y: number[]; z: number[]; scores: number[] } | null
        qr_codes?: string[]
      }
      dataRef.current.mmpose = Object.fromEntries(
        poses.map(({ x, y, z, scores, track }) => [
          track.id,
          scores.map<PoseKeypoint>((s, i) => [
            x[i] * 255,
            y[i] * 255,
            z[i] * 255,
            s * 255,
          ]),
        ]),
      )
      dataRef.current.mp_debug_pose = mp_pose
        ? mp_pose.scores.map<NormalizedLandmark>((s, i) => ({
            x: mp_pose.x[i], y: mp_pose.y[i], z: mp_pose.z[i], visibility: s,
          }))
        : undefined
      dataRef.current.hands = (hands ?? []).map<HandData>(h => ({
        x: h.x,
        y: h.y,
        z: h.z,
        label: h.label as 'Left' | 'Right',
        palmUp: h.palm_up,
      }))
      dataRef.current.qrCodes = qr_codes ?? []
      dataRef.current.lastUpdateTs = performance.now()
    })
    const unsub2 = niceROS.subscribeTopic('/rect_out', ({ markers }) => {
      dataRef.current.kp = markers.map(({ ns, points }) => [
        ns,
        points.map((p) => [p.x, p.y]) as [Point, Point, Point, Point],
      ])
    })

    return () => {
      ;(async () => {
        ;(await unsub1)()
        ;(await unsub2)()
      })()
    }
  }, [niceROS])
  return {}
}
