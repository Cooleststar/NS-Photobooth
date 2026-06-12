import { useStore } from '@nanostores/preact'
import { useEffect } from 'react'
import Booth from './pages/Booth'
import CameraSelect from './pages/CameraSelect'
import QRPage from './pages/QRPage'
import Settings from './pages/Settings'
import { loadDirHandle } from './lib/dirHandle'
import { cameraInitialized, router, saveDirHandle } from './store'

export default function App() {
  const route = useStore(router)?.route

  useEffect(() => {
    loadDirHandle().then((handle) => {
      if (handle) saveDirHandle.set(handle)
    })
  }, [])

  useEffect(() => {
    if ((route === 'booth' || route === 'qr') && !cameraInitialized.get()) {
      router.open('/')
    }
  }, [route])

  if (!route) return <div>404. Not Found.</div>
  return (
    <>
      {
        {
          select: <CameraSelect />,
          booth: <Booth />,
          qr: <QRPage />,
        }[route]
      }
      {route !== 'select' && <Settings />}
    </>
  )
}
