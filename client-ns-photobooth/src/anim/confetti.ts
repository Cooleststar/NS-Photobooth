import * as PIXI from '../pixi'

interface Particle {
  sprite: PIXI.Sprite
  vx: number
  vy: number
  rotSpeed: number
  life: number
  maxLife: number
}

const COLORS = [0xff5e5e, 0xffd166, 0x06d6a0, 0x118ab2, 0xef476f, 0xffffff, 0xa78bfa]
const PARTICLE_COUNT = 45
const GRAVITY = 900 // px/s^2
// Deliberately brief — confetti is a one-shot flourish, not a persistent
// effect, so every particle is fully gone well under a second.
const MAX_LIFE = 0.9

/** One-shot confetti burst — call the returned trigger(x, y) to fire a burst
 * at a screen position. Particles animate under simple gravity + spin and
 * fully self-destroy (removed from the container and disposed) once their
 * lifetime expires, so nothing lingers on screen between bursts. */
export async function createConfettiBurst(app: PIXI.Application) {
  const container = new PIXI.Container()
  const { ticker } = app
  let particles: Particle[] = []

  ticker.add(() => {
    if (particles.length === 0) return
    const dt = ticker.deltaMS / 1000
    const next: Particle[] = []
    for (const p of particles) {
      p.life += dt
      if (p.life >= p.maxLife) {
        container.removeChild(p.sprite)
        p.sprite.destroy()
        continue
      }
      p.vy += GRAVITY * dt
      p.sprite.x += p.vx * dt
      p.sprite.y += p.vy * dt
      p.sprite.rotation += p.rotSpeed * dt
      p.sprite.alpha = 1 - p.life / p.maxLife
      next.push(p)
    }
    particles = next
  })

  const trigger = (x: number, y: number) => {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // A tinted 1x1 white texture stretched into a small rect — avoids
      // needing @pixi/graphics, which isn't an installed dependency here.
      const sprite = new PIXI.Sprite(PIXI.Texture.WHITE)
      sprite.tint = COLORS[Math.floor(Math.random() * COLORS.length)]
      sprite.anchor.set(0.5)
      sprite.width = 5 + Math.random() * 6
      sprite.height = 8 + Math.random() * 6
      sprite.x = x
      sprite.y = y

      const angle = Math.random() * Math.PI * 2
      const speed = 220 + Math.random() * 280
      const vx = Math.cos(angle) * speed
      const vy = Math.sin(angle) * speed - 260 // biased upward, like a pop

      container.addChild(sprite)
      particles.push({
        sprite,
        vx,
        vy,
        rotSpeed: (Math.random() - 0.5) * 12,
        life: 0,
        maxLife: MAX_LIFE * (0.7 + Math.random() * 0.5),
      })
    }
  }

  return [container, trigger] as const
}
