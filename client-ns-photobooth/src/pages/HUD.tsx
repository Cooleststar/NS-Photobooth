import { MutableRefObject, useState } from 'react'
import 'twin.macro'
import { downloadImage, uploadImage } from '../api/cloudinary'
import cameraURI from '../assets/icons/camera_black_48dp.svg'
import { Countdown, KeybindBtn, Modal, useKeybind } from '../components'
import {
  addPicture,
  freezePosition,
  offlineOnly,
  pointerEnabled,
  poseInd,
} from '../store'
import { sleep } from '../utils'

const countdown = parseInt(import.meta.env.VITE_PHOTO_COUNTDOWN)

type CamState = 'ready' | 'timing' | 'confirm' | 'uploading' | 'error'

export interface HUDProps {
  photographerRef: MutableRefObject<(() => Promise<string>) | undefined>
}

export default function HUD({ photographerRef }: HUDProps) {
  const [error, setError] = useState('')
  const [state, setState] = useState<CamState>('ready')
  const [picture, setPicture] = useState('')

  const takePicture = () => {
    if (state !== 'ready')
      return console.warn('attempted picture in wrong state!', state)
    const imgGetter = photographerRef.current
    if (!imgGetter) return console.warn('imgGetter not defined!')
    setState('timing')
    ;(async () => {
      pointerEnabled.set(false)
      freezePosition.set(true)
      await sleep(countdown * 1000)
      window.document.body.style.opacity = '0.2'
      setPicture(await imgGetter())
      await sleep(100)
      window.document.body.style.opacity = '1'
      await sleep(100)
      setState('confirm')
      pointerEnabled.set(true)
      freezePosition.set(false)
    })()
  }

  const cancelUpload = () => setState('ready')

  const confirmUpload = () => {
    if (state !== 'confirm')
      return console.warn('attempted upload in wrong state!', state)
    setState('uploading')

    if (!offlineOnly.get()) {
      uploadImage(picture)
        .then((resp) => {
          console.debug('Cloudinary Response', resp)
          const imgUrl = resp.secure_url
          const url = `${
            import.meta.env.VITE_LANDING_PAGE_URL
          }${imgUrl.substring(
            'https://res.cloudinary.com/aoh2022/image/upload/'.length,
            imgUrl.length,
          )}`
          addPicture({
            timestamp: Date.now(),
            data: imgUrl,
            url,
          })
          setState('ready')
        })
        .catch((e) => {
          console.warn(e)
          setError(e.toString())
          setState('error')
          downloadImage(picture)
        })
    } else {
      const date = new Date()
      downloadImage(picture)
      addPicture({
        timestamp: date.getTime(),
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAADklEQVQY02NgGAVDEgAAAbkAAe14KSUAAAAASUVORK5CYII=', // TODO: need cheap placeholder
        url: `https://example.com/?id=${date.getTime()}`,
      })
      setTimeout(() => setState('ready'), 5000)
    }
  }

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
    case 'confirm':
      return (
        <Modal onDismiss={cancelUpload}>
          <h2>Confirm?</h2>
          <img
            tw='object-scale-down max-h-full max-w-full min-h-0 min-w-0'
            src={picture}
          />
          <span tw='flex flex-row gap-5'>
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
