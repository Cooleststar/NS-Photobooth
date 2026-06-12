import { useStore } from '@nanostores/preact'
import { useNiceROSState } from 'nice-ros-react'
import { useRef, useState } from 'react'
import { storeDirHandle } from '../lib/dirHandle'
import tw from 'twin.macro'
import { WritableAtom } from 'nanostores'
import { KeybindBtn, useKeybind } from '../components'
import {
  GIF_OPTIONS,
  GifOption,
  bannerEnabled,
  camSize,
  canvasSize,
  debugEnabled,
  nicepipeURL,
  offlineOnly,
  owlEnabled,
  pictures,
  pointerEnabled,
  router,
  saveDirHandle,
  saveDirName,
  selectedGif,
  textureCache,
} from '../store'

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div tw='flex flex-col gap-2 py-4 border-b border-gray-800 last:border-0'>
      <p tw='text-[10px] font-semibold uppercase tracking-widest text-gray-500'>{title}</p>
      {children}
    </div>
  )
}

function SwitchRow({ label, boolVar }: { label: string; boolVar: WritableAtom }) {
  const value = useStore(boolVar)
  return (
    <div tw='flex items-center justify-between py-0.5'>
      <span tw='text-sm text-gray-300'>{label}</span>
      <button
        role='switch'
        aria-checked={value}
        tw='relative w-10 h-[22px] rounded-full transition-colors duration-200 focus:outline-none flex-shrink-0'
        css={value ? tw`bg-blue-600` : tw`bg-gray-600`}
        onClick={() => boolVar.set(!value)}
      >
        <span
          tw='absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow transition-transform duration-200'
          css={value && tw`translate-x-[18px]`}
        />
      </button>
    </div>
  )
}

function ResRow({
  label,
  value,
  setter,
}: {
  label: string
  value: { width: number; height: number }
  setter: (v: { width: number; height: number }) => void
}) {
  const widthRef = useRef<HTMLInputElement>(null)
  const heightRef = useRef<HTMLInputElement>(null)
  return (
    <div tw='flex flex-col gap-1'>
      <span tw='text-xs text-gray-500'>{label}</span>
      <div tw='flex items-center gap-2'>
        <input
          ref={widthRef}
          tw='w-16 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded text-center focus:outline-none focus:border-blue-500'
          type='number'
          min={0}
          max={3840}
          defaultValue={value.width}
        />
        <span tw='text-gray-500 text-sm'>×</span>
        <input
          ref={heightRef}
          tw='w-16 bg-gray-800 border border-gray-700 text-white text-sm px-2 py-1.5 rounded text-center focus:outline-none focus:border-blue-500'
          type='number'
          min={0}
          max={2160}
          defaultValue={value.height}
        />
        <button
          tw='flex-1 bg-gray-700 hover:bg-gray-600 text-white text-sm py-1.5 rounded transition-colors'
          onClick={() => {
            const w = parseInt(widthRef.current?.value ?? '0')
            const h = parseInt(heightRef.current?.value ?? '0')
            setter({ width: w, height: h })
          }}
        >
          Set
        </button>
      </div>
    </div>
  )
}


export default function Settings() {
  const route = useStore(router)?.route
  const [shown, setShown] = useState(false)
  const [dirError, setDirError] = useState('')
  const dirName = useStore(saveDirName)
  const url = useStore(nicepipeURL)
  const gifOption = useStore(selectedGif)
  const canvasRes = useStore(canvasSize)
  const camRes = useStore(camSize)
  const niceRos = useNiceROSState()

  useKeybind('KeyD', () => debugEnabled.set(!debugEnabled.get()))
  useKeybind('KeyS', () => setShown((s) => !s))

  return (
    <>
      <button
        tw='fixed top-5 left-5 z-50 w-10 h-10 flex items-center justify-center text-white bg-black bg-opacity-60 rounded-lg opacity-0 hover:opacity-100 transition-opacity text-xl leading-none'
        onClick={() => setShown(!shown)}
      >
        ☰
      </button>

      {shown && (
        <div
          tw='fixed inset-0 z-40 bg-black bg-opacity-40'
          onClick={() => setShown(false)}
        />
      )}

      <div
        tw='fixed top-0 left-0 h-full w-72 z-50 bg-gray-900 text-white flex flex-col shadow-2xl transition-transform duration-300'
        css={!shown ? tw`-translate-x-full` : tw`translate-x-0`}
      >
        <div tw='flex items-center justify-between px-5 py-4 border-b border-gray-800'>
          <h2 tw='text-base font-semibold tracking-wide'>Settings</h2>
          <button
            tw='text-gray-400 hover:text-white transition-colors text-lg leading-none'
            onClick={() => setShown(false)}
          >
            ✕
          </button>
        </div>

        <div tw='flex-1 overflow-y-auto px-5'>
          {route && (
            <Section title='Navigate'>
              {route === 'booth' && (
                <a href='/qr' tw='text-sm text-blue-400 hover:text-blue-300 transition-colors'>
                  Go to QR Page →
                </a>
              )}
              {route === 'qr' && (
                <a href='/booth' tw='text-sm text-blue-400 hover:text-blue-300 transition-colors'>
                  Go to Booth Page →
                </a>
              )}
            </Section>
          )}

          <Section title='Connection'>
            <div tw='flex flex-col gap-1'>
              <span tw='text-xs text-gray-500'>NicePipe URL</span>
              <input
                tw='bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-blue-500'
                type='text'
                value={url}
                placeholder='ws://localhost:9090'
                onChange={(e) =>
                  nicepipeURL.set((e.target as HTMLInputElement).value)
                }
              />
            </div>
            <SwitchRow label='Disable Online Features' boolVar={offlineOnly} />
          </Section>

          <Section title='Storage'>
            <div tw='flex flex-col gap-1'>
              <span tw='text-xs text-gray-500'>Save Folder</span>
              <div tw='flex items-center gap-2'>
                <span tw='flex-1 text-xs text-gray-300 bg-gray-800 border border-gray-700 px-3 py-2 rounded-lg truncate'>
                  {dirName || 'No folder selected'}
                </span>
                <button
                  tw='flex-shrink-0 bg-gray-700 hover:bg-gray-600 text-white text-sm px-3 py-2 rounded-lg transition-colors'
                  onClick={() => {
                    setDirError('')
                    if (!('showDirectoryPicker' in window)) {
                      setDirError('Not supported in this browser')
                      return
                    }
                    ;(window as any).showDirectoryPicker({ mode: 'readwrite' })
                      .then(async (handle: FileSystemDirectoryHandle) => {
                        await storeDirHandle(handle)
                        saveDirHandle.set(handle)
                        saveDirName.set(handle.name)
                      })
                      .catch((e: any) => {
                        if (e?.name !== 'AbortError') setDirError(e?.message ?? String(e))
                      })
                  }}
                >
                  Browse
                </button>
              </div>
              {dirError && (
                <span tw='text-[10px] text-red-400'>{dirError}</span>
              )}
              <span tw='text-[10px] text-gray-600'>
                Photos auto-save here when online features are disabled
              </span>
            </div>
          </Section>

          <Section title='Display'>
            <ResRow label='Canvas Size' value={canvasRes} setter={canvasSize.set} />
            <ResRow label='Camera Size' value={camRes} setter={camSize.set} />
          </Section>

          <Section title='Animation'>
            <div tw='flex flex-col gap-1'>
              <span tw='text-xs text-gray-500'>Animation GIF</span>
              <select
                tw='bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-blue-500'
                value={gifOption}
                onChange={(e) =>
                  selectedGif.set((e.target as HTMLSelectElement).value as GifOption)
                }
              >
                {Object.entries(GIF_OPTIONS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <SwitchRow label='Owl Animation' boolVar={owlEnabled} />
            <SwitchRow label='Banner Animation' boolVar={bannerEnabled} />
            <SwitchRow label='Arrow Pointer' boolVar={pointerEnabled} />
            <SwitchRow label='Debug Animation' boolVar={debugEnabled} />
          </Section>

          <Section title='Actions'>
            <KeybindBtn
              tw='w-full text-sm py-2 px-3 rounded-lg text-left'
              onClick={() => {
                canvasSize.notify()
                niceRos.reset()
              }}
              keyCode='KeyR'
            >
              Reset Connection
            </KeybindBtn>
            <button
              tw='w-full text-sm py-2 px-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-left transition-colors'
              onClick={() => pictures.set([])}
            >
              Clear Image Cache
            </button>
            <button
              tw='w-full text-sm py-2 px-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-left transition-colors'
              onClick={() => textureCache.set({})}
            >
              Clear Texture Cache
            </button>
            <button
              tw='w-full text-sm py-2 px-3 bg-red-900 hover:bg-red-800 text-white rounded-lg text-left transition-colors'
              onClick={() => {
                pictures.set([])
                textureCache.set({})
                router.open('/')
              }}
            >
              Reset Application
            </button>
          </Section>
        </div>

        <div tw='px-5 py-3 border-t border-gray-800'>
          <p tw='text-[10px] text-gray-600 text-center'>
            Powered by JHTech | NiceROS Backend
          </p>
        </div>
      </div>
    </>
  )
}
