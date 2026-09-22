import { useStore } from '@nanostores/preact'
import { useEffect, useState } from 'react'
import tw from 'twin.macro'
import armyCrestUrl from '../assets/icons/army_int_logo.png'
import {
  CameraSource,
  HIKVISION_IPS,
  HIKVISION_USER,
  HIKVISION_PASS,
  cameraInitialized,
  cameraSource,
  customRtspURL,
  getBackendHttpUrl,
  replayVideoLabel,
  router,
  selectedDevice,
} from '../store'

export default function CameraSelect() {
  const camSource = useStore(cameraSource)
  const customUrl = useStore(customRtspURL)
  const replayLabel = useStore(replayVideoLabel)
  const [detectedCam, setDetectedCam] = useState<string>('')
  const [starting, setStarting] = useState(false)

  const isHikvision = (HIKVISION_IPS as readonly string[]).includes(camSource)

  useEffect(() => {
    if (camSource !== 'webcam') return
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const cam = devices.find((d) => d.kind === 'videoinput')
      if (cam) {
        selectedDevice.set(cam.deviceId)
        setDetectedCam(cam.label || 'Camera detected')
      } else {
        setDetectedCam('No camera found')
      }
    })
  }, [camSource])

  const handleStart = async () => {
    if (starting) return
    setStarting(true)

    if (isHikvision) {
      try {
        const res = await fetch(`${getBackendHttpUrl()}/camera/configure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ip: `192.168.1.${camSource}`,
            user: HIKVISION_USER,
            password: HIKVISION_PASS,
            channel: parseInt(camSource),
            stream: 1,
            mjpeg: false,
          }),
        })
        // Camera config is best-effort; proceed even if it fails — but log
        // it, since fetch() only throws on network errors, not HTTP error
        // statuses, so a silent 4xx/5xx here previously left the camera
        // stuck in its slow default encoding with zero visible indication.
        if (!res.ok) {
          console.warn(`Camera configure failed (${res.status}): ${await res.text()}`)
        }
      } catch (e) {
        console.warn('Camera configure request failed:', e)
      }
    }

    cameraInitialized.set(true)
    router.open('/booth')
  }

  return (
    <div tw='fixed inset-0 bg-surface-base flex flex-col items-center justify-center gap-8 text-ink'>
      {/* The unit crest the app already ships as its favicon. The start
          screen carried no identity at all before - just a generic word on a
          dark field - and the badge is the strongest asset here, so it does
          the branding rather than a restyled wordmark competing with the
          lettering already inside it. */}
      <div tw='flex flex-col items-center gap-4'>
        <img src={armyCrestUrl} alt='' tw='w-28 h-28 object-contain' />
        <h1 tw='text-5xl font-bold tracking-tight'>Photobooth</h1>
      </div>
      <p tw='text-ink-dim text-lg -mt-4'>Select a camera to get started</p>

      <div tw='flex flex-col gap-4 w-80'>
        <label tw='flex flex-col gap-1'>
          <span tw='text-sm text-ink-dim'>Camera</span>
          {/* appearance-none strips the OS dropdown chrome - the stock control
              renders with the platform's own arrow and focus ring, which sat
              right above a custom-styled button and gave the screen two
              visual languages. The chevron below replaces it, and is
              pointer-events-none so clicking it still opens the menu. */}
          <div tw='relative'>
          <select
            tw='appearance-none w-full bg-surface-sunken border border-edge text-ink p-3 pr-10 rounded-lg text-base focus:outline-none focus:border-accent'
            value={camSource}
            onChange={(e) =>
              cameraSource.set((e.target as HTMLSelectElement).value as CameraSource)
            }
          >
            <optgroup label='RTSP Cameras'>
              {HIKVISION_IPS.map((ip) => (
                <option key={ip} value={ip}>
                  192.168.1.{ip}
                </option>
              ))}
              <option value='custom'>Custom RTSP...</option>
            </optgroup>
            <optgroup label='Local'>
              <option value='webcam'>USB / Webcam</option>
            </optgroup>
            {/* Chosen from Settings > Testing, which uploads the file; listed
                here only so a saved replay still shows as selected. */}
            {replayLabel && (
              <optgroup label='Testing'>
                <option value='replay'>Test video: {replayLabel}</option>
              </optgroup>
            )}
          </select>
          <span tw='pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted text-xs'>
            ▼
          </span>
          </div>
        </label>

        {camSource === 'custom' && (
          <label tw='flex flex-col gap-1'>
            <span tw='text-sm text-ink-dim'>Custom RTSP URL</span>
            <input
              tw='bg-surface-sunken border border-edge text-ink p-3 rounded-lg text-base'
              type='text'
              value={customUrl}
              placeholder='rtsp://user:pass@192.168.1.x'
              onChange={(e) =>
                customRtspURL.set((e.target as HTMLInputElement).value)
              }
            />
          </label>
        )}

        {camSource === 'webcam' && (
          <div tw='text-sm text-ink-dim px-1'>
            {detectedCam || 'Detecting camera...'}
          </div>
        )}

        <button
          tw='mt-2 bg-accent hover:bg-accent-hover text-ink text-center py-3 rounded-lg text-lg font-semibold transition-colors disabled:opacity-50'
          disabled={starting}
          onClick={handleStart}
        >
          {starting ? 'Configuring camera...' : 'Start'}
        </button>
      </div>
    </div>
  )
}
