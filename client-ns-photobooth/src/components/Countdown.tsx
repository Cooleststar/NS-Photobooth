import { useState } from 'react'
import {
  CountdownCircleTimer,
  TimeProps,
  Props,
} from 'react-countdown-circle-timer'
import tw, { css } from 'twin.macro'

const timeStyle = css`
  ${tw`relative flex justify-center items-center rounded-full h-full w-full`}
  > div {
    ${tw`absolute text-7xl transition-all translate-y-0 opacity-100`}
  }
  .cur-time.time-just-changed {
    ${tw`-translate-y-full opacity-0`}
  }
  .prev-time:not(.time-just-changed) {
    ${tw`translate-y-full opacity-0`}
  }
`

const renderTime = ({ remainingTime, color }: TimeProps) => {
  const [curTime, setCurTime] = useState(remainingTime)
  const [prevTime, setPrevTime] = useState<number>()
  const [timeJustChanged, setTimeJustChanged] = useState(false)

  if (curTime !== remainingTime) {
    setTimeJustChanged(true)
    setPrevTime(curTime)
    setCurTime(remainingTime)
  } else setTimeJustChanged(false)

  const clsName = timeJustChanged ? 'time-just-changed' : ''
  const style = { color }
  return (
    <div css={timeStyle}>
      <div key={remainingTime} className={`cur-time ${clsName}`} style={style}>
        {remainingTime}
      </div>
      {prevTime !== undefined && (
        <div key={prevTime} className={`prev-time ${clsName}`} style={style}>
          {prevTime}
        </div>
      )}
    </div>
  )
}

export function Countdown(props: Props) {
  return <CountdownCircleTimer {...props}>{renderTime}</CountdownCircleTimer>
}
