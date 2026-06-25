import { useEffect, useState } from 'react'
import { useStore } from '../store'

type Which = 'role' | 'memory'

export default function RoleMemoryEditor() {
  const selectedId = useStore((s) => s.selectedAgentId)
  const [which, setWhich] = useState<Which>('role')
  const [text, setText] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!selectedId) return
    let alive = true
    const read = which === 'role' ? window.api.readRole : window.api.readMemory
    void read(selectedId).then((c) => {
      if (alive) setText(c)
    })
    return () => {
      alive = false
    }
  }, [selectedId, which])

  if (!selectedId) return null

  const save = async (): Promise<void> => {
    const write = which === 'role' ? window.api.writeRole : window.api.writeMemory
    await write(selectedId, text)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="panel-section editor">
      <h3>Role &amp; memory</h3>
      <div className="editor-tabs">
        <button className={which === 'role' ? 'active' : ''} onClick={() => setWhich('role')}>
          role.md
        </button>
        <button className={which === 'memory' ? 'active' : ''} onClick={() => setWhich('memory')}>
          memory.md
        </button>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="editor-foot">
        <button className="btn primary" onClick={save}>
          Save {which}.md
        </button>
        {saved && <span className="saved">saved ✓</span>}
      </div>
    </div>
  )
}
