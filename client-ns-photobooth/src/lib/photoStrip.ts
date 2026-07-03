/** Split an array into chunks of at most `size` elements each. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

/** Stack photos vertically into a single strip image (data URL). */
export async function createPhotoStrip(images: string[]): Promise<string> {
  const loaded = await Promise.all(images.map(loadImage))

  const gap = 24
  const padding = 32
  const photoWidth = Math.max(...loaded.map((img) => img.width))
  const totalPhotoHeight = loaded.reduce((sum, img) => sum + img.height, 0)

  const canvas = document.createElement('canvas')
  canvas.width = photoWidth + padding * 2
  canvas.height = totalPhotoHeight + gap * (loaded.length - 1) + padding * 2

  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = padding
  for (const img of loaded) {
    const x = (canvas.width - img.width) / 2
    ctx.drawImage(img, x, y)
    y += img.height + gap
  }

  return canvas.toDataURL(
    import.meta.env.VITE_IMG_UPLOAD_FORMAT,
    parseFloat(import.meta.env.VITE_IMG_UPLOAD_QUALITY),
  )
}
