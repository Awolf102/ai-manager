import { useEffect, useRef, useState } from 'react'
import { Bot, FolderOpen, Send, Square, X } from 'lucide-react'
import { Modal } from './Modal'
import { useStore } from './store'
import { MODELS } from '../shared/types'
import { parseBrief, type AdvisorBrief } from '../shared/advisor'

interface Msg { id: string; role: 'user' | 'assistant'; text: string; turnId?: string; brief?: AdvisorBrief | null }

export default function AdvisorModal() {
  const open = useStore((s) => s.advisorOpen)
  const setOpen = useStore((s) => s.setAdvisorOpen)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [focusPath, setFocusPath] = useState<string | undefined>(undefined)
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [streamingTurn, setStreamingTurn] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // one global subscription for the app's lifetime (this component is always mounted)
  useEffect(() => {
    return window.api.onAdvisorStream((e) => {
      if (e.kind === 'delta') {
        setMsgs((cur) => {
          const i = cur.findIndex((m) => m.turnId === e.turnId)
          if (i === -1) return [...cur, { id: e.turnId, role: 'assistant', text: e.text ?? '', turnId: e.turnId }]
          const next = [...cur]
          next[i] = { ...next[i], text: next[i].text + (e.text ?? '') }
          return next
        })
      } else if (e.kind === 'done') {
        if (e.sessionId) setSessionId(e.sessionId)
        setMsgs((cur) => cur.map((m) => (m.turnId === e.turnId ? { ...m, brief: parseBrief(m.text) } : m)))
        setStreamingTurn((t) => (t === e.turnId ? null : t))
      } else if (e.kind === 'error') {
        setMsgs((cur) => cur.map((m) => (m.turnId === e.turnId ? { ...m, text: m.text + `\n\n⚠ ${e.text ?? 'error'}` } : m)))
        setStreamingTurn((t) => (t === e.turnId ? null : t))
      }
    })
  }, [])

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [msgs])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || streamingTurn) return
    setInput('')
    setMsgs((cur) => [...cur, { id: crypto.randomUUID(), role: 'user', text }])
    const { turnId } = await window.api.sendAdvisor({ message: text, sessionId, focusPath, model })
    setStreamingTurn(turnId)
    setMsgs((cur) => (cur.some((m) => m.turnId === turnId) ? cur : [...cur, { id: turnId, role: 'assistant', text: '', turnId }]))
  }
  const stop = (): void => { if (streamingTurn) window.api.cancelAdvisor(streamingTurn) }
  const pickFolder = async (): Promise<void> => { const p = await window.api.pickAdvisorFolder(); if (p) setFocusPath(p) }
  const newChat = (): void => { setMsgs([]); setSessionId(undefined); setStreamingTurn(null) }

  if (!open) return null

  return (
    <Modal onClose={() => setOpen(false)} labelledBy="advisor-title" className="advisor-modal">
      <div className="modal-header">
        <h2 id="advisor-title" className="modal-title"><Bot size={16} /> Advisor</h2>
        <div className="spacer" />
        <select value={model} onChange={(e) => setModel(e.target.value)} title="Advisor model">
          {MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
        </select>
        <button className="btn" onClick={newChat}>New chat</button>
      </div>
      <div className="modal-body advisor-body">
        <div className="advisor-msgs" ref={listRef}>
          {msgs.length === 0 && <div className="muted advisor-empty">Ask for help planning your project, picking a model/service, or writing a prompt.</div>}
          {msgs.map((m) => (
            <div key={m.id} className={`advisor-msg ${m.role}`}>{m.text || (m.turnId === streamingTurn ? '…' : '')}</div>
          ))}
        </div>
        <div className="advisor-controls">
          {focusPath ? (
            <span className="advisor-chip" title={focusPath}><FolderOpen size={12} /> {focusPath.split(/[\\/]/).pop()} <button aria-label="Clear focus folder" onClick={() => setFocusPath(undefined)}><X size={11} /></button></span>
          ) : (
            <button className="btn" onClick={() => void pickFolder()}><FolderOpen size={13} /> Focus folder</button>
          )}
        </div>
        <div className="advisor-input-row">
          <textarea
            className="advisor-input"
            rows={2}
            placeholder="Message the Advisor…  (Enter to send, Shift+Enter for a new line)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          />
          {streamingTurn ? (
            <button className="btn danger" onClick={stop}><Square size={13} /> Stop</button>
          ) : (
            <button className="btn primary" onClick={() => void send()} disabled={!input.trim()}><Send size={14} /> Send</button>
          )}
        </div>
      </div>
    </Modal>
  )
}
