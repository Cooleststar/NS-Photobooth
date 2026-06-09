import { waitTill } from '../utils'

export async function uploadImage(b64img: string, uploadTimeout = 30000) {
  const date = new Date()
  const data = new FormData()
  /*
  return app.renderer.view.toDataURL(
        // TODO: should these be configurable instead of hardcoded
        import.meta.env.VITE_IMG_UPLOAD_FORMAT,
        parseFloat(import.meta.env.VITE_IMG_UPLOAD_QUALITY),
      )
      */
  // TODO: above should be here, not in Display.tsx
  // Display.tsx should capture image at super-sampled resolution like 4K (even tho camera is 1080p, the graphics are higher res)
  // Then downscale it here using an intermediate canvas where cropping & compression is done
  // Need a legit downscale algorithm that improves rather than hurts quality
  // TODO: landing-page/client-side AI Super Sampling when converting webp back to png for scam?
  // TODO: make sure upscaling the camera doesnt hurt quality

  data.append('file', b64img)
  data.append('upload_preset', import.meta.env.VITE_CLOUDINARY_PRESET)
  data.append(
    'folder',
    `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
  )

  return await (
    await waitTill(
      fetch(
        // TODO: put this in .env by using substitution instead
        `https://api.cloudinary.com/v1_1/${
          import.meta.env.VITE_CLOUDINARY_NAME
        }/image/upload`,
        {
          method: 'POST',
          body: data,
        },
      ),
      uploadTimeout,
    )
  ).json()
}

/** used for testing. downloads image so that quality & size can be inspected. */
export function downloadImage(b64img: string) {
  const ext = b64img.substring('data:image/'.length, b64img.indexOf(';base64'))
  const a = document.createElement('a')
  a.href = b64img
  const date = new Date()
  a.download = `${date.getFullYear()}-${
    date.getMonth() + 1
  }-${date.getDate()}-${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}.${ext}`
  a.click()
}
