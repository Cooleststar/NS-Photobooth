import { useStore } from '@nanostores/preact'
import { useEffect } from 'react'
import Booth from './pages/Booth'
import CameraSelect from './pages/CameraSelect'
import Settings from './pages/Settings'
import { loadPictures } from './lib/picturesDb'
import { cameraInitialized, pictures, router } from './store'

export default function App() {
  const route = useStore(router)?.route

  useEffect(() => {
    loadPictures().then((pics) => {
      if (pics.length) pictures.set(pics)
    })
  }, [])

  useEffect(() => {
    if (route === 'booth' && !cameraInitialized.get()) {
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
        }[route]
      }
      {route !== 'select' && <Settings />}
    </>
  )
}
