/** Sleep for milliseconds. */
export const sleep = (ms: number) => new Promise((cb) => setTimeout(cb, ms))

type EventOf<T extends EventTarget> = Parameters<T['addEventListener']>[0]

// lmao i cant figure out a way to infer the event type
/** Wait for an event. */
export function once<T extends EventTarget, R extends Event>(
  emitter: T,
  event: EventOf<T>,
  timeout: number = 0,
) {
  return new Promise<R>((cb, err) => {
    let timer: number = -1

    const handler = (data: any) => {
      if (timer !== -1) clearTimeout(timer)
      emitter.removeEventListener(event, handler)
      cb(data)
    }

    emitter.addEventListener(event, handler)
    if (timeout !== 0)
      timer = window.setTimeout(() => {
        emitter.removeEventListener(event, handler)
        err('timeout')
      })
  })
}

/** Wait for a promise with timeout. */
export async function waitTill<T>(promise: Promise<T>, timeout: number) {
  let timer: any

  const timeoutPromise = new Promise<T>((cb, err) => {
    timer = setTimeout(
      () => err(new Error(`Function timed out after ${timeout}ms`)),
      timeout,
    )
  })

  const result = await Promise.race([promise, timeoutPromise])
  clearTimeout(timer)
  return result
}
