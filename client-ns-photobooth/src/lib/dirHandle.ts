const DB = 'photobooth-db'
const STORE = 'handles'
const KEY = 'saveDir'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function storeDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(handle, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  return (await handle.requestPermission(opts)) === 'granted'
}

/** Re-encodes a (possibly webp) data URL as a JPEG blob. Photos are captured
 * as webp internally, but files saved to disk should be jpg for broader
 * compatibility (e.g. opening straight in Windows Photo Viewer/Explorer). */
function toJpegBlob(b64img: string, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')!
      // jpg has no alpha channel — flatten onto white first so any
      // transparency doesn't get rendered as black
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode JPEG'))),
        'image/jpeg',
        quality,
      )
    }
    img.onerror = reject
    img.src = b64img
  })
}

/** Saves a base64 data URL as a .jpg file into the user-chosen save folder
 * (see Settings → Storage). Shared by the capture flow (auto-save when
 * online features are disabled) and the gallery's manual "Save to PC". */
export async function saveToDirHandle(
  handle: FileSystemDirectoryHandle | null,
  b64img: string,
  filenamePrefix = 'photo',
): Promise<void> {
  if (!handle) throw new Error('No save folder selected. Choose one in Settings → Storage.')

  const ok = await ensurePermission(handle)
  if (!ok) throw new Error('Permission denied for save folder.')

  const date = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const filename = `${filenamePrefix}_${date.getFullYear()}-${pad(
    date.getMonth() + 1,
  )}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(
    date.getSeconds(),
  )}.jpg`

  const blob = await toJpegBlob(b64img)
  const fileHandle = await handle.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()
}
