import { waitTill } from '../utils'

export interface ImgbbResponse {
  data: {
    url_viewer: string
    url: string
    delete_url: string
  }
  success: boolean
  status: number
}

/** Uploads a captured photo (already has the border/QR-reserved footer
 * baked in by photoStrip.ts) to ImgBB and returns the full API response.
 * `data.url_viewer` is ImgBB's own hosted page for the image — that's what
 * the QR code should point at, since it already has a working download
 * button ImgBB built and tested themselves, sidestepping the cross-origin
 * download-attribute issues a custom landing page would hit on iOS. */
export async function uploadImage(
  b64img: string,
  uploadTimeout = 30000,
): Promise<ImgbbResponse> {
  // ImgBB wants the raw base64 payload, not a full data: URI
  const base64Data = b64img.includes(',') ? b64img.split(',', 2)[1] : b64img

  const data = new FormData()
  data.append('key', import.meta.env.VITE_IMGBB_API_KEY)
  data.append('image', base64Data)
  data.append('name', `photo_${Date.now()}`)

  const resp = await waitTill(
    fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: data,
    }),
    uploadTimeout,
  )

  const json: ImgbbResponse = await resp.json()
  if (!json.success) {
    throw new Error(`ImgBB upload failed: ${JSON.stringify(json)}`)
  }
  return json
}
