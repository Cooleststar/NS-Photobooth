import { MutableRefObject, useState } from 'react'
import 'twin.macro'
import { uploadImage } from '../api/cloudinary'
import cameraURI from '../assets/icons/camera_black_48dp.svg'
import { Countdown, KeybindBtn, Modal, useKeybind } from '../components'
import { ensurePermission } from '../lib/dirHandle'
import { chunkArray, createPhotoStrip } from '../lib/photoStrip'
import {
  addPicture,
  burstCount,
  burstIntervalSec,
  burstModeEnabled,
  freezePosition,
  offlineOnly,
  pointerEnabled,
  poseInd,
  saveDirHandle,
} from '../store'
import { sleep } from '../utils'

const countdown = parseInt(import.meta.env.VITE_PHOTO_COUNTDOWN)
const STRIP_SIZE = 3
const BURST_INTERVAL_MS = () => burstIntervalSec.get() * 1000
const FLASH_MS = 80

type CamState =
  | 'ready'
  | 'timing'
  | 'bursting'
  | 'confirm'
  | 'uploading'
  | 'saving'
  | 'error'

async function saveToDirHandle(b64img: string): Promise<void> {
  const handle = saveDirHandle.get()
  if (!handle) throw new Error('No save folder selected. Choose one in Settings → Storage.')

  const ok = await ensurePermission(handle)
  if (!ok) throw new Error('Permission denied for save folder.')

  const mimeType = b64img.split(';')[0].slice(5)
  const ext = mimeType.split('/')[1]
  const date = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const filename = `photo_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.${ext}`

  const fileHandle = await handle.getFileHandle(filename, { create: true })
  const blob = await fetch(b64img).then((r) => r.blob())
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()
}

async function flash(imgGetter: () => Promise<string>): Promise<string> {
  document.body.style.cursor = 'none'
  window.document.body.style.opacity = '0.2'
  const img = await imgGetter()
  await sleep(100)
  window.document.body.style.opacity = '1'
  await sleep(100)
  document.body.style.cursor = ''
  return img
}

export interface HUDProps {
  photographerRef: MutableRefObject<(() => Promise<string>) | undefined>
}

export default function HUD({ photographerRef }: HUDProps) {
  const [error, setError] = useState('')
  const [state, setState] = useState<CamState>('ready')
  const [images, setImages] = useState<string[]>([])
  const [previewIndex, setPreviewIndex] = useState(0)
  const [burstProgress, setBurstProgress] = useState({ current: 0, total: 0 })
  const [intervalTimerKey, setIntervalTimerKey] = useState(0)
  const [intervalDuration, setIntervalDuration] = useState(1)
  const [showIntervalTimer, setShowIntervalTimer] = useState(false)

  const captureSingle = () => {
    const imgGetter = photographerRef.current!
    setState('timing')
    ;(async () => {
      pointerEnabled.set(false)
      freezePosition.set(true)
      try {
        await sleep(countdown * 1000)
        const img = await flash(imgGetter)
        setImages([img])
        setPreviewIndex(0)
        setState('confirm')
      } catch (e: any) {
        setError(e?.message ?? e.toString())
        setState('error')
      } finally {
        pointerEnabled.set(true)
        freezePosition.set(false)
      }
    })()
  }

  const captureBurst = () => {
    const imgGetter = photographerRef.current!
    setState('timing')
    ;(async () => {
      pointerEnabled.set(false)
      freezePosition.set(true)
      try {
        await sleep(countdown * 1000)

        const total = burstCount.get()
        const captured: string[] = []
        for (let i = 0; i < total; i++) {
          setBurstProgress({ current: i + 1, total })
          setState('bursting')
          document.body.style.cursor = 'none'
          window.document.body.style.opacity = '0.4'
          captured.push(await imgGetter())
          await sleep(FLASH_MS)
          window.document.body.style.opacity = '1'
          document.body.style.cursor = ''
          if (i < total - 1) {
            const intervalMs = BURST_INTERVAL_MS()
            const intervalSec = burstIntervalSec.get()
            setIntervalDuration(intervalSec)
            setIntervalTimerKey((k: number) => k + 1)
            setShowIntervalTimer(true)
            await sleep(intervalMs - FLASH_MS)
            setShowIntervalTimer(false)
          }
        }

        const strips = await Promise.all(
          chunkArray(captured, STRIP_SIZE).map(createPhotoStrip),
        )
        setImages(strips)
        setPreviewIndex(0)
        setState('confirm')
      } catch (e: any) {
        setError(e?.message ?? e.toString())
        setState('error')
      } finally {
        document.body.style.cursor = ''
        window.document.body.style.opacity = '1'
        setShowIntervalTimer(false)
        pointerEnabled.set(true)
        freezePosition.set(false)
      }
    })()
  }

  const takePicture = () => {
    if (state !== 'ready')
      return console.warn('attempted picture in wrong state!', state)
    const imgGetter = photographerRef.current
    if (!imgGetter) return console.warn('imgGetter not defined!')

    if (burstModeEnabled.get()) captureBurst()
    else captureSingle()
  }

  const cancelUpload = () => {
    setImages([])
    setPreviewIndex(0)
    setState('ready')
  }

  const confirmUpload = () => {
    if (state !== 'confirm')
      return console.warn('attempted upload in wrong state!', state)

    if (!offlineOnly.get()) {
      setState('uploading')
      ;(async () => {
        try {
          for (const img of images) {
            const resp = await uploadImage(img)
            const imgUrl = resp.secure_url
            const url = `${import.meta.env.VITE_LANDING_PAGE_URL}${imgUrl.substring(
              'https://res.cloudinary.com/aoh2022/image/upload/'.length,
            )}`
            addPicture({ timestamp: Date.now(), data: imgUrl, url })
          }
          setState('ready')
        } catch (e: any) {
          setError(e.toString())
          setState('error')
        }
      })()
    } else {
      setState('saving')
      ;(async () => {
        try {
          for (const img of images) {
            await saveToDirHandle(img)
            addPicture({ timestamp: Date.now(), data: img, url: '' })
          }
          setState('ready')
        } catch (e: any) {
          setError(e?.message ?? e.toString())
          setState('error')
        }
      })()
    }
  }

  useKeybind('Space', takePicture)

  useKeybind('PageDown', () => {
    if (!['ready', 'timing'].includes(state)) return
    poseInd.set(poseInd.get() + 1)
  })

  switch (state) {
    case 'ready':
      return (
        <KeybindBtn
          keyCode='PageUp'
          onClick={takePicture}
          tw='fixed bottom-2 inset-x-0 m-auto rounded-full h-20 w-20 bg-white opacity-0 hover:(bg-gray-400 opacity-100)'
        >
          <img tw='h-full w-full' src={cameraURI} />
        </KeybindBtn>
      )
    case 'timing':
      return (
        <div tw='inset-0 fixed flex items-center justify-center'>
          <Countdown
            isPlaying
            duration={countdown}
            colors={['#f00', '#0f0']}
            colorsTime={[countdown, 0]}
          />
        </div>
      )
    case 'bursting':
      return (
        <div tw='inset-0 fixed flex flex-col items-center justify-center gap-4'>
          <div tw='text-white text-4xl font-bold bg-black bg-opacity-50 rounded-2xl px-10 py-6'>
            Photo {burstProgress.current} / {burstProgress.total}
          </div>
          {showIntervalTimer && (
            <Countdown
              key={intervalTimerKey}
              isPlaying
              duration={intervalDuration}
              colors={['#0f0', '#f00']}
              colorsTime={[intervalDuration, 0]}
            />
          )}
        </div>
      )
    case 'confirm':
      return (
        <Modal onDismiss={cancelUpload}>
          <h2>
            Confirm?
            {images.length > 1 && ` (Strip ${previewIndex + 1}/${images.length})`}
          </h2>
          <img
            tw='object-scale-down max-h-full max-w-full min-h-0 min-w-0'
            src={images[previewIndex]}
          />
          <span tw='flex flex-row gap-5'>
            {images.length > 1 && (
              <>
                <KeybindBtn
                  onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
                >
                  Prev
                </KeybindBtn>
                <KeybindBtn
                  onClick={() =>
                    setPreviewIndex((i) => Math.min(images.length - 1, i + 1))
                  }
                >
                  Next
                </KeybindBtn>
              </>
            )}
            <KeybindBtn keyCode='PageUp' onClick={confirmUpload}>
              Confirm
            </KeybindBtn>
            <KeybindBtn keyCode='PageDown' onClick={cancelUpload}>
              Cancel
            </KeybindBtn>
          </span>
        </Modal>
      )
    case 'uploading':
      return (
        <Modal locked>
          <h2>Uploading...</h2>
        </Modal>
      )
    case 'saving':
      return (
        <Modal locked>
          <h2>Saving...</h2>
        </Modal>
      )
    case 'error':
      return (
        <Modal>
          <h2>Error</h2>
          <p>{error}</p>
          <KeybindBtn keyCode='PageUp' onClick={() => setState('ready')}>
            Done
          </KeybindBtn>
        </Modal>
      )
  }
}
