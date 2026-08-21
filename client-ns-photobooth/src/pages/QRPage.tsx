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

/** Clock label under each filmstrip thumbnail, so two similar-looking strips
 * can be told apart without opening both. */
const timeLabel = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Shared surface for the side-panel blocks, so they read as one system. */
const panelCard = tw`bg-white rounded-xl border border-gray-200 shadow-sm p-4`

export default function QRPage() {
  const pics = useStore(pictures)
  const [index, setIndex] = useState(pics.length - 1)
  const [frameColor, setFrameColor] = useState(FRAME_COLORS[0])
  const [recoloring, setRecoloring] = useState(false)
  const [savingToPC, setSavingToPC] = useState(false)
  const [savePcError, setSavePcError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const prevLength = useRef(pics.length)

  // Jump to the newest photo whenever a new one is captured, without
  // clobbering the user's manual navigation otherwise.
  useEffect(() => {
    if (pics.length !== prevLength.current) {
      setIndex(pics.length - 1)
      prevLength.current = pics.length
    }
  }, [pics.length])

  // Clear any stale save error/status when switching between photos. The
  // delete confirmation resets too — it must never carry over onto a photo
  // the user has only just navigated to.
  useEffect(() => {
    setSavePcError('')
    setSavingToPC(false)
    setConfirmDelete(false)
  }, [index])

  // Arrow keys move through the filmstrip, so browsing doesn't require
  // aiming at small thumbnails.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(pics.length - 1, i + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pics.length])

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
    // Cleared explicitly rather than relying on the index-change effect: if
    // the surviving photo lands on the same index, that effect never fires
    // and the next photo would open already asking to be deleted.
    setConfirmDelete(false)
  }

  return (
    <Modal locked fullscreen>
      <div tw='w-full flex-1 min-h-0 flex flex-col'>
        <header tw='flex-shrink-0 flex items-baseline justify-between pb-3 border-b border-gray-300'>
          <h2 tw='text-3xl font-semibold text-gray-800'>Your Photos</h2>
          <span tw='text-sm text-gray-500 tabular-nums'>
            {index + 1} of {pics.length}
          </span>
        </header>

        <div tw='flex-1 min-h-0 flex flex-row gap-6 pt-5'>
          {pics.length > 1 && (
            <nav
              aria-label='Photos'
              tw='flex-shrink-0 w-28 flex flex-col gap-3 overflow-y-auto pr-1'
            >
              {pics.map((p, i) => (
                <button
                  key={p.timestamp}
                  onClick={() => setIndex(i)}
                  tw='flex-shrink-0 flex flex-col items-center gap-1 rounded-lg p-1 bg-white border-2 border-transparent transition hover:border-gray-400'
                  css={i === index && tw`border-red-600 shadow`}
                >
                  {/* width-fixed, height-auto so burst-mode strips (tall,
                      stacked photos) show in full instead of being cropped */}
                  <img
                    src={p.data}
                    tw='w-full h-auto max-h-32 object-contain block rounded'
                  />
                  <span tw='text-xs leading-none text-gray-500 tabular-nums'>
                    {timeLabel(p.timestamp)}
                  </span>
                </button>
              ))}
            </nav>
          )}

          <div tw='flex-1 min-w-0 flex items-center justify-center'>
            {isStrip ? (
              <div tw='relative rounded-sm shadow-lg overflow-hidden'>
                <img
                  key={index}
                  src={data}
                  css={fadeIn}
                  tw='max-w-2xl max-h-full w-auto h-auto object-contain block'
                />
                {recoloring && (
                  <div tw='absolute inset-0 bg-white bg-opacity-70 flex items-center justify-center text-sm text-gray-700 font-medium'>
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
                  tw='max-w-2xl max-h-full w-auto h-auto object-contain block'
                />
              </div>
            )}
          </div>

          <aside tw='flex-shrink-0 w-72 flex flex-col gap-4 overflow-y-auto'>
            {hasShareLink ? (
              <div css={panelCard} tw='flex flex-col items-center gap-2'>
                <QRCodeSVG value={url} tw='w-44 h-44' />
                <p tw='text-sm font-medium text-gray-700'>Scan to download</p>
                {isStrip && (
                  <p tw='text-xs text-gray-500 text-center'>
                    Also printed on your strip
                  </p>
                )}
              </div>
            ) : (
              <div css={panelCard} tw='flex flex-col items-center gap-2'>
                <div tw='flex items-center gap-2 text-sm text-gray-500'>
                  <span tw='w-2 h-2 rounded-full bg-gray-400' />
                  Saved offline — no QR code
                </div>
              </div>
            )}

            <div css={panelCard}>
              <p tw='text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3'>
                Background
              </p>
              <div tw='flex flex-row flex-wrap gap-3'>
                {swatchColors.map((color) => (
                  <button
                    key={color}
                    aria-label={`Set colour ${color}`}
                    onClick={() => handleColorClick(color)}
                    disabled={recoloring}
                    tw='w-8 h-8 rounded-full border-2 border-white shadow ring-1 ring-gray-300 transition hover:scale-110 disabled:opacity-50 disabled:pointer-events-none'
                    style={{ backgroundColor: color }}
                    css={color === activeColor && tw`ring-2 ring-offset-2 ring-gray-600`}
                  />
                ))}
              </div>
            </div>

            <div css={panelCard} tw='flex flex-col gap-2'>
              <button
                onClick={handleSaveToPC}
                disabled={savingToPC}
                tw='w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-3 py-2 transition'
              >
                {savingToPC ? 'Saving…' : 'Save to PC'}
              </button>
              {savePcError && (
                <p tw='text-xs text-red-500 text-center'>{savePcError}</p>
              )}

              {/* Two-step delete: this is the only destructive control on a
                  screen guests use unsupervised. */}
              {confirmDelete ? (
                <div tw='flex gap-2'>
                  <button
                    onClick={handleDelete}
                    tw='flex-1 rounded-lg bg-red-700 hover:bg-red-800 text-white text-sm font-medium px-3 py-2 transition'
                  >
                    Delete for good
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    tw='flex-1 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium px-3 py-2 transition'
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  tw='w-full rounded-lg border border-red-300 text-red-700 hover:bg-red-50 text-sm font-medium px-3 py-2 transition'
                >
                  Delete
                </button>
              )}
            </div>

            <div tw='flex flex-row items-center justify-center gap-4 pt-1 opacity-60'>
              <img src={logo11} tw='w-10 h-auto object-contain' />
              <img src={fusionLogo} tw='w-10 h-auto object-contain' />
            </div>
          </aside>
        </div>

        <footer tw='flex-shrink-0 flex items-center justify-center pt-4 mt-4 border-t border-gray-300'>
          <Btn onClick={() => router.open('/booth')}>← Back to Booth</Btn>
        </footer>
      </div>
    </Modal>
  )
}
