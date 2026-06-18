import { useStore } from '@nanostores/preact'
import { useEffect, useState } from 'react'
import tw from 'twin.macro'
import {
  CameraSource,
  HIKVISION_IPS,
  HIKVISION_USER,
  HIKVISION_PASS,
  cameraInitialized,
  cameraSource,
  customRtspURL,
  router,
  selectedDevice,
} from '../store'

export default function CameraSelect() {
  const camSource = useStore(cameraSource)
  const customUrl = useStore(customRtspURL)
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
        await fetch('http://localhost:8081/camera/configure', {
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
      } catch {
        // Camera config is best-effort; proceed even if it fails
      }
    }

    cameraInitialized.set(true)
    router.open('/booth')
  }

  return (
    <div tw='fixed inset-0 bg-black flex flex-col items-center justify-center gap-8 text-white'>
      <h1 tw='text-5xl font-bold tracking-tight'>Photobooth</h1>
      <p tw='text-gray-400 text-lg'>Select a camera to get started</p>

      <div tw='flex flex-col gap-4 w-80'>
        <label tw='flex flex-col gap-1'>
          <span tw='text-sm text-gray-400'>Camera</span>
          <select
            tw='bg-gray-800 border border-gray-600 text-white p-3 rounded-lg text-base'
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
          </select>
        </label>

        {camSource === 'custom' && (
          <label tw='flex flex-col gap-1'>
            <span tw='text-sm text-gray-400'>Custom RTSP URL</span>
            <input
              tw='bg-gray-800 border border-gray-600 text-white p-3 rounded-lg text-base'
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
          <div tw='text-sm text-gray-400 px-1'>
            {detectedCam || 'Detecting camera...'}
          </div>
        )}

        <button
          tw='mt-2 bg-white text-black text-center py-3 rounded-lg text-lg font-semibold hover:bg-gray-200 transition-colors disabled:opacity-50'
          disabled={starting}
          onClick={handleStart}
        >
          {starting ? 'Configuring camera...' : 'Start'}
        </button>
      </div>
    </div>
  )
}
