/** Sleep for milliseconds. */
export const sleep = (ms: number) => new Promise((cb) => setTimeout(cb, ms))

/** Wait for a promise with timeout. */
export async function waitTill<T>(promise: Promise<T>, timeout: number) {
  let timer: any

  const timeoutPromise = new Promise<T>((_, err) => {
    timer = setTimeout(
      () => err(new Error(`Function timed out after ${timeout}ms`)),
      timeout,
    )
  })

  const result = await Promise.race([promise, timeoutPromise])
  clearTimeout(timer)
  return result
}
