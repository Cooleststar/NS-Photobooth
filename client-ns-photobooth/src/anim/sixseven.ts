import * as PIXI from '../pixi'
import KalmanFilter from 'kalmanjs'

import { lerpLinear, lerpEO } from './utils'
import { AnimStateManager } from './AnimState'
import { HandData } from '../api/nicepipe'

import sixImg from '../assets/sixseven/six.png'
import sevenImg from '../assets/sixseven/seven.png'

// The "6 7" gesture: both palms flat to the sky with the arms held diagonally
// (one hand clearly higher than the other) puts a 6 above the lower-x palm and
// a 7 above the higher-x palm.
//
// Unrelated to 67 Mode (store's challenge67*, anim/challenge67/, Challenge67UI)
// — that is the arm-flapping mini-game, this is an ordinary AnimPicker prop.
//
// Built from drone.ts (same palmSky signal, palm centering, greedy nearest-
// first claiming, Kalman + eased follow, fade lifecycle), but slots here own a
// PAIR of sprites driven by one AnimStateManager — the batears.ts pattern — so
// a 6 and its 7 always appear and disappear together as one prop.

const ANIM = {
  FADE: parseFloat(import.meta.env.VITE_ANIM_FADE),
  RETRACK: parseFloat(import.meta.env.VITE_ANIM_RETRACK),
}

const KF_PARAMS = { R: 0.02, Q: 1.5 }
const NUMBER_SIZE_FACTOR = 0.22
const BOB_SPEED = 2.5
const BOB_AMPLITUDE_FACTOR = 0.014
const PALM_HOLD_TIME = 0.4
const PALM_CONFIRM_TIME = 0.15
const FOLLOW_RATE = 14

// Two hands per pair, and the backend caps at 8 simultaneous hands
// (WILOR_MAX_HANDS in backend/wilor_hands.py), so four pairs is the real
// ceiling — anything more would be starved of data.
const PAIR_SLOTS = 4

// How far a slot may reach to re-claim one of its two hands, as a fraction of
// screen width. Same value and same reasoning as drone.ts's constant of the
// same name: a hand only moves a small fraction of the screen between backend
// samples, so anything further away is a different hand rather than this one
// having moved.
const MAX_CLAIM_DISTANCE_FACTOR = 0.25

// Bounds on how far apart two palms may be to be considered one person's pair.
// Hands closer than the minimum are the same hand double-detected or two
// hands too bunched to read as a gesture; beyond the maximum they belong to
// different people. Widen MAX if the gesture fails with arms spread wide;
// narrow it if two people standing shoulder to shoulder get cross-paired.
const MIN_PAIR_DX_FACTOR = 0.05
const MAX_PAIR_DX_FACTOR = 0.55
const MAX_PAIR_DIST_FACTOR = 0.6

// The diagonal gate, as the angle of the line between the two palms: 0 is
// level, 90 degrees is one hand stacked directly above the other.
//
// Deliberately an angle rather than a vertical distance: a raw |dy| threshold
// is not scale-invariant, so someone standing at the back of the booth (whose
// whole body spans fewer pixels) could never reach it. A |dy|/|dx| ratio is
// scale-invariant too but blows up as dx approaches zero and its threshold
// isn't linear in perceived tilt.
//
// ENTER > EXIT is hysteresis: it takes a clear tilt to trigger, but a
// shallower one to keep going, so a pair held near the threshold doesn't
// strobe on and off. MAX rejects near-vertical pairs, which are two people at
// different distances from the camera rather than one person's two arms.
const DIAGONAL_ENTER_ANGLE = (20 * Math.PI) / 180
const DIAGONAL_EXIT_ANGLE = (12 * Math.PI) / 180
const DIAGONAL_MAX_ANGLE = (72 * Math.PI) / 180

interface Point { x: number; y: number }
interface FeedBounds { left: number; right: number; top: number; bottom: number }
/** Where a pair's two numbers should sit this frame. */
interface PairTarget { six: Point; seven: Point }
/** A slot's current targets, for the assigner. `active` distinguishes a slot
 * showing a pair from an idle one — only an idle slot may acquire hands at any
 * distance, since it has nothing on screen to teleport. */
interface SlotPos { six: Point; seven: Point; active: boolean }

function clampPos(x: number, y: number, size: number, b: FeedBounds) {
  const half = size * 0.5
  return {
    x: Math.max(b.left + half, Math.min(b.right - half, x)),
    y: Math.max(b.top + half, Math.min(b.bottom - half, y)),
  }
}

// Wrist + the four finger MCP (knuckle) joints — their average approximates
// the palm's center at any hand orientation. Same set drone.ts uses.
const PALM_LANDMARKS = [0, 5, 9, 13, 17]

function palmCenter(h: HandData, height: number, width: number): Point {
  let x = 0, y = 0
  for (const i of PALM_LANDMARKS) { x += h.x[i]; y += h.y[i] }
  x /= PALM_LANDMARKS.length
  y /= PALM_LANDMARKS.length
  return { x: (1 - x) * width, y: y * height }
}

/** Tilt of the line between two palms, 0 (level) to PI/2 (stacked vertically).
 * Absolute on both axes so it measures tilt magnitude only, independent of
 * which hand is on which side or which is higher. */
function pairAngle(a: Point, b: Point) {
  return Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x))
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Match palm-up-to-the-sky hands to pair slots.
 *
 * Active slots re-claim their own two hands FIRST, before any new pairing is
 * considered. Re-pairing everything from scratch each frame would give the
 * pairing stage no continuity: the backend only reports its top hands by
 * confidence and that set churns, so a different combination can win from one
 * frame to the next. Pair midpoints are also degenerate — many wrong
 * combinations share one — so matching slots by midpoint alone would let a
 * slot silently inherit a pair built from someone else's hand.
 */
function assignPairsToSlots(
  hands: HandData[],
  slots: SlotPos[],
  height: number,
  width: number,
): Array<PairTarget | undefined> {
  const available = hands
    .filter((h) => h.palmSky)
    .map((h) => palmCenter(h, height, width))

  const result: Array<PairTarget | undefined> = slots.map(() => undefined)
  const claimed = new Set<number>()

  // --- Phase 1: active slots re-acquire their own hands -------------------
  const maxClaim = width * MAX_CLAIM_DISTANCE_FACTOR
  const recovered = slots.map(() => ({ six: -1, seven: -1 }))
  const claims: Array<{ slot: number; hand: number; role: 'six' | 'seven'; d: number }> = []
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i].active) continue
    for (let j = 0; j < available.length; j++) {
      const dSix = Math.hypot(available[j].x - slots[i].six.x, available[j].y - slots[i].six.y)
      if (dSix <= maxClaim) claims.push({ slot: i, hand: j, role: 'six', d: dSix })
      const dSeven = Math.hypot(available[j].x - slots[i].seven.x, available[j].y - slots[i].seven.y)
      if (dSeven <= maxClaim) claims.push({ slot: i, hand: j, role: 'seven', d: dSeven })
    }
  }
  // Nearest first rather than slot 0 first, so an early slot can't take a hand
  // that is a much better match for a later one.
  claims.sort((a, b) => a.d - b.d)
  for (const { slot, hand, role } of claims) {
    if (claimed.has(hand) || recovered[slot][role] >= 0) continue
    recovered[slot][role] = hand
    claimed.add(hand)
  }
  for (let i = 0; i < slots.length; i++) {
    const { six, seven } = recovered[i]
    if (six >= 0 && seven >= 0) {
      // Roles stay stuck to the hand each already had — deliberately NOT
      // re-sorted by x, or crossing the hands mid-gesture would swap the
      // glyphs over.
      result[i] = { six: available[six], seven: available[seven] }
    } else {
      // Half a pair is not a pair: release the one hand it did find back to
      // the pool so a new pair can use it, and let the slot's hold timer cover
      // the gap in case this is just detection flicker.
      if (six >= 0) claimed.delete(six)
      if (seven >= 0) claimed.delete(seven)
    }
  }

  // --- Phase 2: form new pairs from whatever is left ----------------------
  const free: number[] = []
  for (let i = 0; i < available.length; i++) if (!claimed.has(i)) free.push(i)

  const minDx = width * MIN_PAIR_DX_FACTOR
  const maxDx = width * MAX_PAIR_DX_FACTOR
  const maxDist = width * MAX_PAIR_DIST_FACTOR
  const candidates: Array<{ a: number; b: number; d: number }> = []
  for (let m = 0; m < free.length; m++) {
    for (let n = m + 1; n < free.length; n++) {
      const a = available[free[m]]
      const b = available[free[n]]
      const dx = Math.abs(a.x - b.x)
      if (dx < minDx || dx > maxDx) continue
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (d > maxDist) continue
      const theta = pairAngle(a, b)
      if (theta < DIAGONAL_ENTER_ANGLE || theta > DIAGONAL_MAX_ANGLE) continue
      candidates.push({ a: free[m], b: free[n], d })
    }
  }
  // Ranked by plain distance, closest first — NOT by how diagonal the pair is.
  // Preferring the steepest diagonal would actively favour the cross-person
  // case (one person's raised hand with another's lowered one); closeness in
  // both axes is the cheap proxy for "same body".
  candidates.sort((a, b) => a.d - b.d)
  const newPairs: PairTarget[] = []
  for (const { a, b } of candidates) {
    if (claimed.has(a) || claimed.has(b)) continue
    claimed.add(a)
    claimed.add(b)
    const pa = available[a]
    const pb = available[b]
    // Smaller screen x gets the 6. The feed is mirrored (x_screen =
    // (1 - x) * width), which puts a person's own left hand on the left of the
    // screen — the whole point of a mirrored feed — so screen-left is their
    // left palm. HandData.label is deliberately not consulted: nothing else in
    // this codebase uses it and its orientation here is unverified.
    newPairs.push(pa.x <= pb.x ? { six: pa, seven: pb } : { six: pb, seven: pa })
  }

  // New pairs go to IDLE slots only. An active slot that failed to re-acquire
  // above must not be handed a different person's pair — it would visibly jump
  // across the screen — so it is left undefined to fade out on its own.
  const idle: number[] = []
  for (let i = 0; i < slots.length; i++) {
    if (result[i] === undefined && !slots[i].active) idle.push(i)
  }
  const links: Array<{ slot: number; pair: number; d: number }> = []
  for (const slot of idle) {
    const sm = midpoint(slots[slot].six, slots[slot].seven)
    for (let p = 0; p < newPairs.length; p++) {
      const pm = midpoint(newPairs[p].six, newPairs[p].seven)
      links.push({ slot, pair: p, d: Math.hypot(sm.x - pm.x, sm.y - pm.y) })
    }
  }
  // No distance cap here — an idle slot is off screen, so there is nothing to
  // teleport. Nearest-first only so a person who briefly dropped the gesture
  // tends to land back on the slot they had.
  links.sort((a, b) => a.d - b.d)
  const usedSlot = new Set<number>()
  const usedPair = new Set<number>()
  for (const { slot, pair } of links) {
    if (usedSlot.has(slot) || usedPair.has(pair)) continue
    result[slot] = newPairs[pair]
    usedSlot.add(slot)
    usedPair.add(pair)
  }

  return result
}

interface Glyph {
  sprite: PIXI.Sprite
  kf: { x: KalmanFilter; y: KalmanFilter }
  /** Filtered palm position — the target, updated only when a sample arrives. */
  target: Point
  /** What is actually rendered, eased toward `target` every frame. */
  drawn: Point
}

function createGlyph(texture: PIXI.Texture, size: number): Glyph {
  const sprite = PIXI.Sprite.from(texture)
  sprite.anchor.set(0.5, 0.5)
  // Both source PNGs are proportion-matched (each glyph fills ~67.5% of its
  // square canvas height, centred), so equal square sizes render the 6 and 7
  // at matching visual heights with no per-glyph correction.
  sprite.width = size
  sprite.height = size
  return {
    sprite,
    kf: { x: new KalmanFilter(KF_PARAMS), y: new KalmanFilter(KF_PARAMS) },
    target: { x: 0, y: 0 },
    drawn: { x: 0, y: 0 },
  }
}

function createNumberPair(
  app: PIXI.Application,
  sixTex: PIXI.Texture,
  sevenTex: PIXI.Texture,
  size: number,
  hoverOffset: number,
  bobAmplitude: number,
  bounds: FeedBounds,
) {
  const { ticker } = app
  const { height } = app.renderer

  const container = new PIXI.Container()
  const six = createGlyph(sixTex, size)
  const seven = createGlyph(sevenTex, size)
  const glyphs = [six, seven]
  for (const g of glyphs) container.addChild(g.sprite)

  const initialState = () => {
    container.alpha = 0
  }
  initialState()

  // Shared across both glyphs so the pair reads as one prop: they seed, bob
  // and fade as a unit rather than drifting out of phase with each other.
  let hasDrawn = false
  let bobTime = 0
  let palmHoldTimer = 0
  let palmConfirmTimer = 0
  /** Drop the eased positions so a pair that faded out and is re-acquired
   * elsewhere appears there rather than flying across the screen.
   *
   * Deliberately NOT part of initialState(): that runs during setup, before
   * these bindings exist, and touching them from there throws through the
   * temporal dead zone — which silently prevents the whole animation from
   * being created. Same trap as drone.ts and ocfusion.ts. */
  const resetEasing = () => {
    hasDrawn = false
  }

  const animManager = new AnimStateManager()

  const getTrackedPos = (): SlotPos => ({
    six: { ...six.target },
    seven: { ...seven.target },
    active: animManager.tracking,
  })

  const placeGlyph = (g: Glyph, y: number) => {
    const p = clampPos(g.drawn.x, y, size, bounds)
    g.sprite.position.set(p.x, p.y)
  }

  const update = (target: PairTarget | undefined) => {
    const dt = ticker.deltaMS / 1000

    // Re-tested every frame, with the looser threshold once already showing
    // (see DIAGONAL_ENTER_ANGLE).
    let angleOk = false
    if (target) {
      const theta = pairAngle(target.six, target.seven)
      const minAngle = animManager.tracking ? DIAGONAL_EXIT_ANGLE : DIAGONAL_ENTER_ANGLE
      angleOk = theta >= minAngle && theta <= DIAGONAL_MAX_ANGLE
    }

    if (target) {
      // Positions follow even while the angle is failing, so a pair that is
      // fading out stays glued to the hands instead of freezing mid-air.
      six.target.x = six.kf.x.filter(target.six.x)
      six.target.y = six.kf.y.filter(target.six.y)
      seven.target.x = seven.kf.x.filter(target.seven.x)
      seven.target.y = seven.kf.y.filter(target.seven.y)
      if (!hasDrawn) {
        // Seed on the FIRST REAL detection, not the first tick: ticks arrive
        // before any hand does, and seeding from the still-zero target would
        // make the numbers fly in from the top-left corner.
        for (const g of glyphs) { g.drawn.x = g.target.x; g.drawn.y = g.target.y }
        hasDrawn = true
      }
    }

    if (target && angleOk) {
      palmHoldTimer = PALM_HOLD_TIME
      palmConfirmTimer = Math.min(PALM_CONFIRM_TIME, palmConfirmTimer + dt)
    } else {
      palmHoldTimer = Math.max(0, palmHoldTimer - dt)
      // Confirmation must be one continuous detection, not accumulated
      // flickers, or it stops filtering noise.
      palmConfirmTimer = 0
    }

    // Framerate-independent easing, so it looks the same at 60 or 144 Hz.
    if (hasDrawn) {
      const k = 1 - Math.exp(-FOLLOW_RATE * dt)
      for (const g of glyphs) {
        g.drawn.x += (g.target.x - g.drawn.x) * k
        g.drawn.y += (g.target.y - g.drawn.y) * k
      }
    }

    // The hold timer covers a detection GAP only. Hands that are present but
    // no longer diagonal kill the pair at once — the gesture is over, and
    // holding on for another 0.4s would just look like lag.
    const alive = animManager.tracking
      ? (target ? angleOk : palmHoldTimer > 0)
      : (palmConfirmTimer >= PALM_CONFIRM_TIME && angleOk)

    animManager.tracking = alive
    const { time, state } = animManager

    switch (state) {
      case 'exited':
        initialState()
        resetEasing()
        bobTime = 0
        break

      case 'entering': {
        container.alpha = lerpLinear(time, 0, ANIM.FADE)
        const progress = lerpEO(time, 0, ANIM.FADE)
        for (const g of glyphs) {
          const endY = g.drawn.y - hoverOffset
          const startY = endY - height * 0.2
          placeGlyph(g, startY + (endY - startY) * progress)
        }
        if (time >= ANIM.FADE) animManager.transition()
        break
      }

      case 'entered':
        container.alpha = 1
        bobTime += dt
        for (const g of glyphs) {
          placeGlyph(g, g.drawn.y - hoverOffset + Math.sin(bobTime * BOB_SPEED) * bobAmplitude)
        }
        break

      case 'lost':
        // No re-track grace, same as drone/ocfusion — the hold timer above
        // already covers brief detection gaps.
        animManager.transition()
        break

      case 'exiting':
        container.alpha = 1 - lerpLinear(time, 0, ANIM.FADE)
        for (const g of glyphs) {
          placeGlyph(g, g.drawn.y - hoverOffset + Math.sin(bobTime * BOB_SPEED) * bobAmplitude)
        }
        if (time >= ANIM.FADE) {
          initialState()
          resetEasing()
          animManager.transition()
        }
        break
    }

    animManager.update(dt)
  }

  return [container, update, getTrackedPos] as const
}

export async function createSixSevenAnim(
  app: PIXI.Application,
  margins = { mx: 30 / 1920, mt: 30 / 1080, mb: 30 / 1080 },
) {
  const { height, width } = app.renderer

  const bounds: FeedBounds = {
    left: margins.mx * width,
    right: (1 - margins.mx) * width,
    top: margins.mt * height,
    bottom: (1 - margins.mb) * height,
  }

  const size = height * NUMBER_SIZE_FACTOR
  // Anchor is centred and the visible glyph fills ~67.5% of the sprite box, so
  // half a box up leaves roughly 0.16 * size of clear air between the glyph's
  // bottom edge and the palm — a gap, without floating away from the hand.
  const hoverOffset = size * 0.5
  const bobAmplitude = height * BOB_AMPLITUDE_FACTOR

  // Loaded once and shared across every slot, so PixiJS can batch them.
  const [sixTex, sevenTex] = await Promise.all([
    PIXI.ensureLoaded(app.loader, sixImg).then((r) => r.texture!),
    PIXI.ensureLoaded(app.loader, sevenImg).then((r) => r.texture!),
  ])

  const pairs = Array.from({ length: PAIR_SLOTS }, () =>
    createNumberPair(app, sixTex, sevenTex, size, hoverOffset, bobAmplitude, bounds),
  )

  const parentContainer = new PIXI.Container()
  for (const [container] of pairs) parentContainer.addChild(container)

  const update = (hands: HandData[]) => {
    const slots = pairs.map(([, , getPos]) => getPos())
    const assigned = assignPairsToSlots(hands, slots, height, width)
    pairs.forEach(([, updateSlot], i) => updateSlot(assigned[i]))
  }

  return [parentContainer, update] as const
}
