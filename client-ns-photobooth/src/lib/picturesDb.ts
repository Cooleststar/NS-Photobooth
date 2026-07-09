import type { Picture } from '../store'

// Photos are stored as base64 data URLs, which can easily blow past
// localStorage's ~5-10MB quota once a few burst-mode strips pile up. IndexedDB
// has a much larger (disk-backed) quota, so gallery photos & their download
// links survive an app restart instead of silently failing to persist.
const DB = 'photobooth-pictures-db'
const STORE = 'pictures'
const KEY = 'all'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadPictures(): Promise<Picture[]> {
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve(req.result ?? [])
      req.onerror = () => resolve([])
    })
  } catch {
    return []
  }
}

export async function savePictures(pics: Picture[]): Promise<void> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(pics, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (e) {
    console.error('Failed to persist pictures', e)
  }
}
