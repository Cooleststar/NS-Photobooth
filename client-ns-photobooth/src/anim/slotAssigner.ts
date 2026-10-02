// Person -> animation slot assignment for multi-target animations, split out
// of Display.tsx so it can be tested without PIXI. Pure apart from the clock,
// which is injectable for the same reason.

/** Stable person -> slot assignment for multi-target animations.
 *
 * Poses arrive keyed by tracker id, and Object.keys() returns those keys in
 * ascending numeric order — so driving slot i from ids[i] re-shuffles every
 * slot the moment anyone enters or leaves, and a newcomer whose id sorts
 * below an existing one shifts all the slots after it. Each slot owns its
 * own Kalman filters and AnimState, so a reshuffle makes a mask slide off
 * its person and across to another, briefly stacking two masks on one face.
 *
 * Keying by tracker id instead means a person holds the same slot for as
 * long as they are tracked, whoever else comes and goes.
 *
 * An id that goes missing keeps its slot reserved for `holdMs` before the
 * slot is freed. Someone briefly hidden behind another person's raised arm
 * gets no box from the detector for a few frames, while the tracker keeps
 * their id alive (track_buffer in botsort_photobooth.yaml). Freeing the slot
 * on the first missing frame meant that when they reappeared under the same
 * id, the longest-free-first rule below handed them a DIFFERENT slot: their
 * owl/bat/mask was abandoned to exit and a brand-new one flew in from the
 * corner - which read as one person blocking another's tracking. While
 * reserved, the slot is fed nothing, so its animation sits in its own 'lost'
 * state and resumes from there if the id returns. Keep `holdMs` no longer
 * than that 'lost' window (VITE_ANIM_RETRACK), or the slot would still be
 * held for an animation that has already left. */
export function createSlotAssigner<T>(
  slotCount: number,
  holdMs: number,
  now: () => number = () => performance.now(),
) {
  const slotOf = new Map<number, number>()
  /** ids missing since `since`, still holding `slot` */
  const reserved = new Map<number, { slot: number; since: number }>()
  const freedAt = new Array<number>(slotCount).fill(-Infinity)

  return (allPoses: { [id: number]: T }): (T | undefined)[] => {
    const t = now()
    const ids = Object.keys(allPoses).map(Number)
    const present = new Set(ids)

    for (const [id, slot] of [...slotOf]) {
      if (!present.has(id)) {
        slotOf.delete(id)
        reserved.set(id, { slot, since: t })
      }
    }
    for (const [id, r] of [...reserved]) {
      if (present.has(id)) {
        // Back within the hold: same slot, so its animation resumes.
        reserved.delete(id)
        slotOf.set(id, r.slot)
      } else if (t - r.since >= holdMs) {
        reserved.delete(id)
        freedAt[r.slot] = t
      }
    }

    const occupied = new Set(slotOf.values())
    for (const r of reserved.values()) occupied.add(r.slot)
    const free: number[] = []
    for (let i = 0; i < slotCount; i++) if (!occupied.has(i)) free.push(i)
    // Longest-free first, so a slot isn't handed straight to a new person
    // while its filters are still settled on the previous one.
    free.sort((a, b) => freedAt[a] - freedAt[b])

    let next = 0
    for (const id of ids) {
      if (slotOf.has(id)) continue
      if (next < free.length) {
        slotOf.set(id, free[next++])
        continue
      }
      // Every slot taken or reserved: someone present outranks a hold, so
      // give up the oldest reservation rather than leave them unrendered.
      let oldestId: number | undefined
      let oldestSince = Infinity
      for (const [rid, r] of reserved) {
        if (r.since < oldestSince) {
          oldestSince = r.since
          oldestId = rid
        }
      }
      if (oldestId === undefined) break // more people than slots — extras go unrendered
      slotOf.set(id, reserved.get(oldestId)!.slot)
      reserved.delete(oldestId)
    }

    const bySlot = new Array<T | undefined>(slotCount)
    for (const [id, slot] of slotOf) bySlot[slot] = allPoses[id]
    return bySlot
  }
}
