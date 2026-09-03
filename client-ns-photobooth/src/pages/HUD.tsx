import { useStore } from '@nanostores/preact'
import { MutableRefObject, useState } from 'react'
import 'twin.macro'
import { uploadImage } from '../api/imgbb'
import cameraURI from '../assets/icons/camera_black_48dp.svg'
import { AnimPicker, OcFusionPicker, Countdown, KeybindBtn, Modal, useKeybind } from '../components'
import {
  addQrToStrip,
  chunkArray,
  createPhotoStrip,
  DEFAULT_STRIP_BG,
} from '../lib/photoStrip'
import {
  addPicture,
  burstCount,
  burstIntervalSec,
  burstModeEnabled,
  freezePosition,
  getBackendHttpUrl,
  offlineOnly,
  photoCountdownSec,
  pointerEnabled,
  poseInd,
} from '../store'
import { sleep } from '../utils'

const STRIP_SIZE = 3
const BURST_INTERVAL_MS = () => burstIntervalSec.get() * 1000
const FLASH_MS = 80

type CamState =
  | 'ready'
  | 'timing'
  | 'bursting'
  | 'confirm'
  | 'uploading'
  | 'error'

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
  const countdown = useStore(photoCountdownSec)
  const [error, setError] = useState('')
  const [state, setState] = useState<CamState>('ready')
  const [images, setImages] = useState<string[]>([])
  const [stripGroups, setStripGroups] = useState<string[][]>([])
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
        await sleep(photoCountdownSec.get() * 1000)
        const img = await flash(imgGetter)
        // single photos get the same card border treatment as burst strips
        // (see photoStrip.ts) instead of the old baked-in banner overlay
        const card = await createPhotoStrip([img])
        setImages([card])
        setStripGroups([[img]])
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
        await sleep(photoCountdownSec.get() * 1000)

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

        const groups = chunkArray(captured, STRIP_SIZE)
        const strips = await Promise.all(
          groups.map((group) => createPhotoStrip(group)),
        )
        setImages(strips)
        setStripGroups(groups)
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

  const savePicture = (
    timestamp: number,
    data: string,
    url: string,
    stripIdx: number,
  ) => {
    addPicture({
      timestamp,
      data,
      url,
      isStrip: true,
      stripPhotos: stripGroups[stripIdx],
      bgColor: DEFAULT_STRIP_BG,
    })
    fetch(`${getBackendHttpUrl()}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: data,
        url,
        timestamp,
        stripPhotos: stripGroups[stripIdx],
      }),
    }).catch(() => {})
  }

  const confirmUpload = () => {
    if (state !== 'confirm')
      return console.warn('attempted upload in wrong state!', state)

    if (!offlineOnly.get()) {
      setState('uploading')
      ;(async () => {
        try {
          for (let i = 0; i < images.length; i++) {
            const img = images[i]
            const timestamp = Date.now()
            // ImgBB's own hosted viewer page — already has a working
            // download button ImgBB built and tested themselves, so the
            // QR points straight at it instead of a custom landing page.
            const resp = await uploadImage(img)
            const url = resp.data.url_viewer
            const data = await addQrToStrip(img, url, stripGroups[i].length)
            savePicture(timestamp, data, url, i)
          }
          setState('ready')
        } catch (e: any) {
          setError(e.toString())
          setState('error')
        }
      })()
    } else {
      const baseTimestamp = Date.now()
      for (let i = 0; i < images.length; i++) {
        // Offset each strip by 1ms: the loop runs synchronously with no
        // await between iterations, so Date.now() alone can return the same
        // millisecond for several strips and collide on the backend's
        // per-photo filename.
        savePicture(baseTimestamp + i, images[i], '', i)
      }
      setState('ready')
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
        <>
          <KeybindBtn
            keyCode='PageUp'
            onClick={takePicture}
            tw='fixed bottom-2 inset-x-0 m-auto rounded-full h-20 w-20 bg-white opacity-0 hover:(bg-gray-400 opacity-100)'
          >
            <img tw='h-full w-full' src={cameraURI} />
          </KeybindBtn>
          <AnimPicker />
          <OcFusionPicker />
        </>
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
