import { useStore } from '@nanostores/preact'
import Booth from './pages/Booth'
import QRPage from './pages/QRPage'
import Settings from './pages/Settings'
import { router } from './store'

export default function App() {
  const route = useStore(router)?.route
  if (!route) return <div>404. Not Found.</div>
  return (
    <>
      {
        {
          home: <Booth />,
          qr: <QRPage />,
        }[route]
      }
      <Settings />
    </>
  )
}
