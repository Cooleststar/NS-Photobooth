import { useStore } from '@nanostores/preact'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import 'twin.macro'
import { Btn, Modal } from '../components'
import { pictures, router } from '../store'

/* TODO: Sidebar for previous images. */

export default function QRPage() {
  const [picInd, setPicInd] = useState(-1)
  const pics = useStore(pictures)

  if (picInd > -1) setPicInd(-1)
  const { data, url } = pics.at(picInd)!
  const hasPrev = pics.at(picInd - 1) !== undefined
  const hasNext = picInd < -1
  return (
    <Modal locked>
      <h2>Get your picture here!</h2>
      <span tw='flex flex-row flex-nowrap'>
        <QRCodeSVG value={url} tw='flex-shrink-0 w-52 h-auto' />
        <div tw='flex-shrink'>
          <img src={data} tw='w-auto' />
        </div>
      </span>
      <span tw='flex gap-5'>
        <Btn disabled={!hasPrev} onClick={() => setPicInd(picInd - 1)}>
          Previous
        </Btn>
        <Btn disabled={!hasNext} onClick={() => setPicInd(picInd + 1)}>
          Next
        </Btn>
        <Btn onClick={() => router.open('/booth')}>
          Back to Booth
        </Btn>
      </span>
    </Modal>
  )
}
