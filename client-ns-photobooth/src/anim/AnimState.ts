export type AnimState = 'exited' | 'entering' | 'entered' | 'lost' | 'exiting'

export class AnimStateManager {
  /** time elapsed */
  private elapsed = 0.0
  /** exited -> entering -> entered -> exiting -> exited */
  private animState: AnimState = 'exited'
  /** time elapsed at moment of tracking loss */
  private whenLost = 0.0
  /** animState before getting lost */
  private lostState: AnimState = 'exited'

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
