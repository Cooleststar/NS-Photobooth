import { useStore } from '@nanostores/preact'
import { CamSelector, useNiceROSState } from 'nice-ros-react'
import { useState } from 'react'
import tw, { css } from 'twin.macro'
import {
  Btn,
  KeybindBtn,
  Modal,
  ResolutionInput,
  Toggle,
  useKeybind,
} from '../components'
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
  router,
  selectedDevice,
  selectedGif,
  textureCache,
} from '../store'

const settingStyle = css`
  ${tw`items-baseline`}
  input {
    &[type='number'] {
      &::-webkit-inner-spin-button,
      &::-webkit-outer-spin-button {
        appearance: none;
        -webkit-appearance: none;
        margin: 0;
      }
    }

    &[type='checkbox'] {
      ${tw`align-middle`}
    }

    &[type='text'] {
      ${tw`border-black border-b-[1px]`}
    }
  }
  a {
    ${tw`text-blue-400 hover:underline`}
  }
`

export default function Settings() {
  const route = useStore(router)?.route
  const [shown, setShown] = useState(false)
  const url = useStore(nicepipeURL)
  const gifOption = useStore(selectedGif)
  const canvasRes = useStore(canvasSize)
  const camRes = useStore(camSize)
  const deviceId = useStore(selectedDevice)
  const niceRos = useNiceROSState()

  useKeybind('KeyD', () => {
    debugEnabled.set(!debugEnabled.get())
  })

  return (
    <>
      <KeybindBtn
        tw='fixed top-5 left-5 text-white bg-black bg-opacity-70 opacity-0 hover:opacity-100 text-3xl'
        onClick={() => setShown(!shown)}
        keyCode='KeyS'
      >
        ☰
      </KeybindBtn>
      <Modal
        css={settingStyle}
        onDismiss={() => {
          setShown(false)
          return false
        }}
        hidden={!shown}
      >
        <h2>Settings</h2>
        {route &&
          {
            home: <a href='/qr'>Go to QR Page</a>,
            qr: <a href='/'>Go to Booth Page</a>,
          }[route]}
        <label>
          nicepipe URL:{' '}
          <input
            type='text'
            value={url}
            placeholder='e.g. ws://localhost:9090'
            onChange={(e) =>
              nicepipeURL.set((e.target as HTMLInputElement).value)
            }
          />
        </label>
        <ResolutionInput
          resolutionHook={[canvasRes, canvasSize.set]}
          label='Canvas Size'
        />
        <ResolutionInput
          resolutionHook={[camRes, camSize.set]}
          label='Camera Size'
        />
        <CamSelector
          deviceIdHook={[deviceId, selectedDevice.set]}
          videoConstraints={camRes}
        />
        <Toggle label='Disable Online Features' boolVar={offlineOnly} />
        <Toggle label='Enable Debug Anim' boolVar={debugEnabled} />
        <Toggle label='Enable Owl Anim' boolVar={owlEnabled} />
        <label>
          Animation GIF:{' '}
          <select
            value={gifOption}
            onChange={(e) =>
              selectedGif.set((e.target as HTMLSelectElement).value as GifOption)
            }
          >
            {Object.entries(GIF_OPTIONS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <Toggle label='Enable Banner Anim' boolVar={bannerEnabled} />
        <span>
          <KeybindBtn
            tw='text-base inline mr-1'
            onClick={() => {
              canvasSize.notify()
              // nicepipeURL.notify()
              // New API doesn't trigger if URL is same
              niceRos.reset()
            }}
            keyCode='KeyR'
          >
            Reset Connection
          </KeybindBtn>
          <Btn tw='text-base inline mr-1' onClick={() => pictures.set([])}>
            Clear Image Cache
          </Btn>
          <Btn tw='text-base inline' onClick={() => textureCache.set({})}>
            Clear Texture Cache
          </Btn>
        </span>

        <p>Powered by JHTech | NiceROS Backend</p>
      </Modal>
    </>
  )
}
