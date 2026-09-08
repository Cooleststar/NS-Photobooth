import { NormalizedLandmarkList } from '../api/landmarks'
import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear } from './utils'
import { convertPoint } from '../api/nicepipe/mpPose'
import { AnimStateManager } from './AnimState'

import earsImg from '../assets/batears/batearsicon.png'

// Was two separate mirror-image sprites (leftear.png/rightear.png), each
// with its own crown-derived position, a per-ear rotation offset (so they
// splayed outward from each other), and profile-turn handling that hid
// whichever ear turned out of view. Swapped on request to a single combined
// image with both ears baked in (like pignose.ts's PigEar.png) —
// batearsicon.png here, not a separate icon-only asset despite the
// filename: per-ear independence doesn't apply to one fused sprite, so this
// is simpler — one anchor point, one scale, one rotation for the pair as a
// whole, same pattern as pignose's ear-pair piece / ocfusion.ts's face
// mask. A profile turn now just rotates/foreshortens the whole pair as a
// rigid flat image, same as any single 2D prop viewed edge-on — an
// inherent flat-art limitation, not something code can compensate for the
// way the old two-sprite version could.
const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.03, Q: 2 }

// ---------------------------------------------------------------------------
// Ear art geometry — measured from batearsicon.png's alpha channel, not
// guessed. 1024x559, content bbox (295,70)-(729,445): centred horizontally
// (x 0.288..0.712, matching the head's own left-right symmetry), bottom
// edge — where the ears meet the head — at y=0.796.
// ---------------------------------------------------------------------------

/** Where the ear pair's own base (bottom-centre, i.e. where it meets the
 * head) sits in the artwork, as a fraction of the image. Anchoring here
 * (rather than the sprite centre) is what lets the pair be pinned to a
 * single crown point, same role as pignose.ts's EAR_BASE_ANCHOR. */
const EAR_BASE_ANCHOR = { x: 0.5, y: 0.796 }

/** How wide the ear pair's visible content is, as a fraction of the image's
 * width. Used to convert a *desired visible width* (relative to ear-to-ear
 * distance) into the full sprite width PIXI needs to be told. */
const EAR_CONTENT_WIDTH_FRACTION = 0.424

/** Desired *visible* width of the ear PAIR, relative to ear-to-ear distance.
 * NOT directly comparable to the old two-sprite version's per-ear
 * EAR_VISIBLE_SIZE_FACTOR (0.728) — that sized one ear at a time with a
 * separate EAR_SPREAD_FACTOR controlling the gap between them, whereas this
 * is the whole fused pair's span, spread baked into the art. Starting point,
 * not yet measured against a live face — tune this if the pair looks too
 * big/small once seen running. */
const EAR_VISIBLE_SIZE_FACTOR = 1.15

/** How far above the nose the ear pair's base sits, in ear-to-ear distances.
 * Reused as-is from the previous two-sprite implementation's own
 * CROWN_OFFSET_FACTOR (0.65, most recently tuned up from 0.45 — the pair had
 * been sitting low, clustered near the eyebrows/forehead) rather than
 * re-derived from scratch: "how far above the nose do ears sit" isn't a
 * question the art swap changes the answer to. Tune this if the pair sits
 * too low/high on the head. */
const EAR_CROWN_OFFSET_FACTOR = 0.65

// A jump larger than this (in ear-to-ear distances) means this animation
// slot has been handed to a different person, not that someone moved.
// Same reasoning as clownwignose.ts/pignose.ts/ocfusion.ts.
const REBIND_SNAP_RATIO = 1.5

const NOSE_VISIBILITY_MIN = 0.5
const EAR_VISIBILITY_MIN = 0.3

/** Ear-pair crown point, head scale and tilt from MP-33 pose landmarks
 * (nose=0, ears=7/8). Same sparse-face-point approach as
 * clownwignose.ts/pignose.ts — there's no face-mesh detector in this
 * pipeline, so the face points already present in body pose are reused.
 * The pair is positioned above the nose along the head's own "up"
 * direction rather than tracked to the real ear landmarks directly — those
 * are noisy/awkwardly-placed for this, per the previous implementation's
 * own note — same headband-style placement as before. */
function getEarTarget(
  pose: NormalizedLandmarkList,
  height: number,
  width: number,
) {
  if (pose.length === 0) return undefined
  const nose = pose[0]
  const leftEar = pose[7]
  const rightEar = pose[8]
  if (!nose || !leftEar || !rightEar) return undefined
  if ((nose.visibility ?? 1) < NOSE_VISIBILITY_MIN) return undefined
  if (
    (leftEar.visibility ?? 1) < EAR_VISIBILITY_MIN &&
    (rightEar.visibility ?? 1) < EAR_VISIBILITY_MIN
  ) {
    return undefined
  }

  const n = convertPoint(nose, height, width)
  const le = convertPoint(leftEar, height, width)
  const re = convertPoint(rightEar, height, width)

  const earDist = Math.hypot(le.x - re.x, le.y - re.y)
  if (earDist < 1) return undefined

  // Roll from the ear-to-ear line, so the pair tilts with the head.
  const angle = Math.atan2(re.y - le.y, re.x - le.x)

  // "Up" is perpendicular to the ear line rather than screen-up, so the
  // pair stays on the head when it tilts instead of sliding off sideways.
  const upX = Math.sin(angle)
  const upY = -Math.cos(angle)

  return {
    x: n.x + upX * earDist * EAR_CROWN_OFFSET_FACTOR,
    y: n.y + upY * earDist * EAR_CROWN_OFFSET_FACTOR,
    earDist,
    angle,
  }
}

export async function createBatEarsAnim(app: PIXI.Application) {
  const {
    renderer: { height, width },
    ticker,
    loader,
  } = app

  const container = new PIXI.Container()
  const { texture } = await PIXI.ensureLoaded(loader, earsImg)

  const sprite = PIXI.Sprite.from(texture!)
  sprite.anchor.set(EAR_BASE_ANCHOR.x, EAR_BASE_ANCHOR.y)
  container.addChild(sprite)

  const makeFilters = () => ({
    x: new KalmanFilter(KF_PARAMS),
    y: new KalmanFilter(KF_PARAMS),
    size: new KalmanFilter(KF_PARAMS),
    angle: new KalmanFilter(KF_PARAMS),
  })
  let kf = makeFilters()
  // whether kf currently holds a recent target belonging to this same person
  let bound = false

  const initialState = () => {
    container.alpha = 0
    bound = false
  }
  initialState()

  let x = 0
  let y = 0
  let earDist = 100
  let angle = 0
  const animManager = new AnimStateManager()

  const update = (pose: NormalizedLandmarkList) => {
    const target = getEarTarget(pose, height, width)
    if (target) {
      const jumped =
        bound &&
        Math.hypot(target.x - x, target.y - y) > target.earDist * REBIND_SNAP_RATIO
      if (jumped || !bound) {
        // Fresh person for this slot: drop the previous person's filter
        // state so the ears appear on them rather than travelling there.
        kf = makeFilters()
        bound = true
      }
      x = kf.x.filter(target.x)
      y = kf.y.filter(target.y)
      earDist = kf.size.filter(target.earDist)
      angle = kf.angle.filter(target.angle)
    }

    sprite.width = (earDist * EAR_VISIBLE_SIZE_FACTOR) / EAR_CONTENT_WIDTH_FRACTION
    sprite.height = sprite.width * (texture!.height / texture!.width)
    sprite.rotation = angle

    animManager.tracking = !!target
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        break

      case 'entering':
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        container.position.set(x, y)
        if (time >= ANIM.FADE) animManager.transition()
        break

      case 'entered':
        container.alpha = 1
        container.position.set(x, y)
        break

      case 'lost':
        if (time >= ANIM.RETRACK) animManager.transition()
        break

      case 'exiting':
        container.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
        if (time >= ANIM.FADE) {
          initialState()
          animManager.transition()
        }
        break
    }

    animManager.update(ticker.deltaMS / 1000)
  }

  return [container, update] as const
}
