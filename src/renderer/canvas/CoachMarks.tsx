import { useState } from 'react'

const KEY = 'orkestr:canvas:coachmarks-seen'

export default function CoachMarks() {
  const [show, setShow] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== '1'
    } catch {
      return false
    }
  })
  if (!show) return null
  const dismiss = (): void => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* ignore */
    }
    setShow(false)
  }
  return (
    <div className="coachmarks" role="dialog" aria-label="Canvas tips">
      <h3>Working the canvas</h3>
      <ul>
        <li><b>Connect</b> agents by dragging from one node's <b>bottom</b> to another's <b>top</b> — the lower one reports up the chain.</li>
        <li><b>Dashed</b> lines are the reporting tree; a <b>handoff</b> line is a lateral ask (click a line → "Make handoff").</li>
        <li>Use <b>Order</b> to number which teams run first; <b>Tidy</b> re-arranges the layout.</li>
      </ul>
      <button className="btn primary" onClick={dismiss}>Got it</button>
    </div>
  )
}
