import { useStore } from '@nanostores/preact'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'
import tw, { css } from 'twin.macro'
import { uploadImage } from '../api/imgbb'
import logo11 from '../assets/icons/11logo.png'
import fusionLogo from '../assets/icons/fusionlogo.png'
import { Btn, Modal } from '../components'
import { saveToDirHandle } from '../lib/dirHandle'
import { addQrToStrip, createPhotoStrip, STRIP_BG_OPTIONS } from '../lib/photoStrip'
import { deletePicture, getBackendHttpUrl, Picture, pictures, router, saveDirHandle, updatePicture } from '../store'

const fadeIn = css`
  animation: qrpage-fade-in 250ms ease;
  @keyframes qrpage-fade-in {
    from {
      opacity: 0;
      transform: scale(0.98);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
`

// decorative frame color for single (non-strip) photos — client-side only
const FRAME_COLORS = ['#e5e7eb', '#ef4444', '#3b82f6', '#22c55e', '#eab308']

export default function QRPage() {
  const pics = useStore(pictures)
  const [index, setIndex] = useState(pics.length - 1)
  const [frameColor, setFrameColor] = useState(FRAME_COLORS[0])
  const [recoloring, setRecoloring] = useState(false)
  const [savingToPC, setSavingToPC] = useState(false)
  const [savePcError, setSavePcError] = useState('')
  const prevLength = useRef(pics.length)

  // Jump to the newest photo whenever a new one is captured, without
  // clobbering the user's manual navigation otherwise.
  useEffect(() => {
    if (pics.length !== prevLength.current) {
      setIndex(pics.length - 1)
      prevLength.current = pics.length
    }
  }, [pics.length])

  // Clear any stale save error/status when switching between photos.
  useEffect(() => {
    setSavePcError('')
    setSavingToPC(false)
  }, [index])

  // Sync any photos not yet on the backend. Uses sessionStorage to avoid
  // re-uploading the same photo across re-renders.
  useEffect(() => {
    if (pics.length === 0) return
    const backendUrl = getBackendHttpUrl()
    const KEY = 'synced_timestamps'
    const synced = new Set<number>(JSON.parse(sessionStorage.getItem(KEY) ?? '[]'))
    pics
      .filter((p: Picture) => !synced.has(p.timestamp))
      .forEach((p: Picture) => {
        fetch(`${backendUrl}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: p.data, url: p.url, timestamp: p.timestamp, stripPhotos: p.stripPhotos ?? [] }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`save failed: ${res.status}`)
            synced.add(p.timestamp)
            sessionStorage.setItem(KEY, JSON.stringify([...synced]))
          })
          .catch((err) => {
            console.error(`Failed to sync photo ${p.timestamp} to backend:`, err)
          })
      })
  }, [pics])

  if (pics.length === 0) {
    return (
      <Modal locked>
        <h2>No pictures taken</h2>
        <Btn onClick={() => router.open('/booth')}>Back to Booth</Btn>
      </Modal>
    )
  }

  const pic = pics[index]
  const { data, url, isStrip, stripPhotos, bgColor } = pic
  const hasShareLink = !!url

  // Strip colors are baked into the actual image, so changing one means
  // regenerating the strip and — if it was uploaded — re-uploading it and
  // re-baking the QR so the share link keeps pointing at a matching image.
  const handleColorClick = async (color: string) => {
    if (!isStrip || !stripPhotos) {
      setFrameColor(color)
      return
    }
    if (color === bgColor || recoloring) return
    setRecoloring(true)
    try {
      const base = await createPhotoStrip(stripPhotos, color, pic.timestamp)
      if (hasShareLink) {
        const resp = await uploadImage(base)
        const newUrl = resp.data.url_viewer
        const withQr = await addQrToStrip(base, newUrl, stripPhotos.length)
        updatePicture(pic.timestamp, { data: withQr, url: newUrl, bgColor: color })
      } else {
        updatePicture(pic.timestamp, { data: base, bgColor: color })
      }
    } finally {
      setRecoloring(false)
    }
  }

  const swatchColors = isStrip ? STRIP_BG_OPTIONS : FRAME_COLORS
  const activeColor = isStrip ? bgColor : frameColor

  const handleSaveToPC = async () => {
    setSavingToPC(true)
    setSavePcError('')
    try {
      await saveToDirHandle(saveDirHandle.get(), data)
    } catch (e: any) {
      setSavePcError(e?.message ?? String(e))
    } finally {
      setSavingToPC(false)
    }
  }

  const handleDelete = () => {
    deletePicture(pic.timestamp)
  }

  return (
    <Modal locked fullscreen>
      <h2>Get your picture here!</h2>

      {hasShareLink && (
        <div tw='absolute right-8 top-1/2 -translate-y-1/2 flex flex-col items-center gap-3 bg-gray-50 rounded-2xl p-6 shadow-lg border border-gray-200'>
          <QRCodeSVG value={url} tw='w-64 h-64' />
          <p tw='text-lg text-gray-600 font-medium'>Scan to download</p>
        </div>
      )}

      <span tw='flex flex-row items-start gap-6'>
        {pics.length > 1 && (
          <div tw='flex flex-col gap-3 overflow-y-auto max-h-[70vh] p-1'>
            {pics.map((p, i) => (
              // width-fixed, height-auto so burst-mode strips (tall, stacked
              // photos) show in full instead of being cropped to a square
              <img
                key={p.timestamp}
                src={p.data}
                onClick={() => setIndex(i)}
                tw='w-24 h-auto max-h-40 flex-shrink-0 object-contain bg-gray-100 rounded-sm cursor-pointer border-2 opacity-70 hover:opacity-100 transition'
                css={i === index && tw`border-red-600 opacity-100`}
              />
            ))}
          </div>
        )}

        <span tw='flex flex-col items-center gap-5'>
          <span tw='flex flex-row flex-wrap justify-center items-start gap-6'>
            {isStrip ? (
              <div tw='relative rounded-sm shadow-lg overflow-hidden'>
                <img
                  key={index}
                  src={data}
                  css={fadeIn}
                  tw='max-w-xl max-h-[70vh] w-auto h-auto object-contain block'
                />
                {recoloring && (
                  <div tw='absolute inset-0 bg-white bg-opacity-60 flex items-center justify-center text-sm text-gray-700 font-medium'>
                    Updating colour…
                  </div>
                )}
              </div>
            ) : (
              <div
                css={css`background-color: ${frameColor};`}
                tw='p-3 rounded-sm shadow-lg'
              >
                <img
                  key={index}
                  src={data}
                  css={fadeIn}
                  tw='max-w-xl max-h-[70vh] w-auto h-auto object-contain block'
                />
              </div>
            )}

            <span tw='flex flex-col items-center gap-4'>
              <div tw='flex flex-row items-center gap-3'>
                {hasShareLink ? (
                  isStrip ? (
                    <p tw='text-sm text-gray-500 max-w-[10rem] text-center'>
                      QR code is printed on the strip
                    </p>
                  ) : (
                    <div tw='flex flex-col items-center gap-2 bg-gray-50 rounded-xl p-4 shadow border border-gray-200'>
                      <QRCodeSVG value={url} tw='w-40 h-40' />
                      <p tw='text-sm text-gray-600'>Scan to download</p>
                    </div>
                  )
                ) : (
                  <div tw='flex flex-col items-center gap-2 bg-gray-50 rounded-xl p-4 shadow border border-gray-200'>
                    <div tw='flex items-center gap-2 text-sm text-gray-500'>
                      <span tw='w-2 h-2 rounded-full bg-gray-400' />
                      Saved offline — no QR code
                    </div>
                    <button
                      onClick={handleSaveToPC}
                      disabled={savingToPC}
                      tw='rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm px-3 py-1.5 transition'
                    >
                      {savingToPC ? 'Saving…' : 'Save to PC'}
                    </button>
                    {savePcError && (
                      <p tw='text-xs text-red-500 max-w-[12rem] text-center'>
                        {savePcError}
                      </p>
                    )}
                  </div>
                )}

                <div tw='flex flex-col items-center gap-2'>
                  <img src={logo11} tw='w-12 h-auto object-contain' />
                  <img src={fusionLogo} tw='w-12 h-auto object-contain' />
                </div>
              </div>

              <span tw='flex flex-col items-center gap-3'>
                {swatchColors.map((color) => (
                  <button
                    key={color}
                    aria-label={`Set colour ${color}`}
                    onClick={() => handleColorClick(color)}
                    disabled={recoloring}
                    tw='w-7 h-7 rounded-full border-2 border-white shadow ring-1 ring-gray-300 transition hover:scale-110 disabled:opacity-50 disabled:pointer-events-none'
                    style={{ backgroundColor: color }}
                    css={color === activeColor && tw`ring-2 ring-offset-2 ring-gray-500`}
                  />
                ))}
              </span>
            </span>
          </span>

          <span tw='flex items-center gap-4'>
            <Btn onClick={() => router.open('/booth')}>Back to Booth</Btn>
            <button
              onClick={handleDelete}
              tw='rounded bg-red-700 hover:bg-red-900 text-white p-2 text-xl'
            >
              Delete
            </button>
          </span>
        </span>
      </span>
    </Modal>
  )
}
