export type AnimState = 'exited' | 'entering' | 'entered' | 'lost' | 'exiting'

export interface AnimStateOptions {
  /** If tracking returns while 'exiting', resume where the animation was
   * before it got lost (the same thing 'lost' already does) instead of
   * finishing the exit and starting a fresh 'entering'.
   *
   * Off by default so every existing animation keeps its behaviour; an
   * animation that turns it on must make its 'entering'/'entered' branches
   * restore whatever its 'exiting' branch hid or started playing, since
   * those branches can now run straight after it. */
  resumeFromExit?: boolean
}

export class AnimStateManager {
  /** time elapsed */
  private elapsed = 0.0
  /** exited -> entering -> entered -> exiting -> exited */
  private animState: AnimState = 'exited'
  /** time elapsed at moment of tracking loss */
  private whenLost = 0.0
  /** animState before getting lost */
  private lostState: AnimState = 'exited'
  private readonly resumeFromExit: boolean

  constructor(options: AnimStateOptions = {}) {
    this.resumeFromExit = options.resumeFromExit ?? false
  }

  /** update tracker with elapsed delta in seconds */
  update(delta: number) {
    this.elapsed += delta
  }

  /** tells stateManager should go to next animState */
  transition() {
    this.elapsed = 0
    switch (this.animState) {
      case 'entering':
        this.animState = 'entered'
        break
      case 'lost':
        this.animState = 'exiting'
        break
      case 'exiting':
        this.animState = 'exited'
        break
    }
  }

  set tracking(isTracking: boolean) {
    if (isTracking) {
      switch (this.animState) {
        case 'exiting':
          if (!this.resumeFromExit) break
        // falls through - lostState/whenLost still describe where the
        // animation was before the loss that led into this exit
        case 'lost':
          this.animState = this.lostState
          this.elapsed = this.whenLost
          break
        case 'exited':
          this.elapsed = 0
          this.animState = 'entering'
          break
      }
    } else {
      if (this.tracking) {
        this.lostState = this.animState
        this.animState = 'lost'
        this.whenLost = this.elapsed
        this.elapsed = 0
      }
    }
  }

  get tracking() {
    return ['entered', 'entering'].includes(this.animState)
  }

  get time() {
    return this.elapsed
  }

  get state() {
    return this.animState
  }
}
