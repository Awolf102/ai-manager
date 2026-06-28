import { describe, it, expect } from 'vitest'
import { detectManifestPrompt, parseManifest, parseStartCommand } from './run-manifest'

describe('detectManifestPrompt', () => {
  it('includes the goal, the JSON shape, the serve-static hint, and the default-path rule', () => {
    const p = detectManifestPrompt('build a CSV explorer', 'package.json scripts: {"dev":"vite"}', 'final report text')
    expect(p).toContain('build a CSV explorer')
    expect(p).toContain('"startCommand"')
    expect(p).toContain('python3 -m http.server')
    expect(p).toContain('localhost')
    expect(p).toContain('package.json scripts: {"dev":"vite"}')
    expect(p).toContain('final report text')
  })
})

describe('parseManifest', () => {
  it('parses a full web manifest from a fenced json block surrounded by prose', () => {
    const text = 'Here you go:\n```json\n{"type":"web","startCommand":"npm run dev","port":5173,"path":"/","notes":"vite"}\n```\nDone.'
    expect(parseManifest(text)).toEqual({
      type: 'web',
      startCommand: 'npm run dev',
      port: 5173,
      path: '/',
      notes: 'vite'
    })
  })

  it('coerces an unknown type to "unknown"', () => {
    const r = parseManifest('{"type":"webby","startCommand":"x"}')
    expect(r?.type).toBe('unknown')
  })

  it('defaults a missing path to "/" and normalizes a relative path', () => {
    expect(parseManifest('{"type":"web","startCommand":"x"}')?.path).toBe('/')
    expect(parseManifest('{"type":"web","startCommand":"x","path":"app"}')?.path).toBe('/app')
  })

  it('drops a non-positive or non-numeric port', () => {
    expect(parseManifest('{"type":"web","startCommand":"x","port":0}')?.port).toBeUndefined()
    expect(parseManifest('{"type":"web","startCommand":"x","port":"abc"}')?.port).toBeUndefined()
  })

  it('returns null when there is no JSON object', () => {
    expect(parseManifest('sorry, no idea')).toBeNull()
  })
})

describe('parseStartCommand', () => {
  it('splits a simple command into command + args', () => {
    expect(parseStartCommand('npm run dev')).toEqual({ ok: true, command: 'npm', args: ['run', 'dev'] })
    expect(parseStartCommand('vite --port 5173')).toEqual({ ok: true, command: 'vite', args: ['--port', '5173'] })
    expect(parseStartCommand('python3 -m http.server 8000')).toEqual({
      ok: true,
      command: 'python3',
      args: ['-m', 'http.server', '8000']
    })
  })

  it('honors single and double quotes, keeping operators inside them literal', () => {
    expect(parseStartCommand('node "my server.js"')).toEqual({ ok: true, command: 'node', args: ['my server.js'] })
    expect(parseStartCommand("node 'my server.js'")).toEqual({ ok: true, command: 'node', args: ['my server.js'] })
    expect(parseStartCommand('node "a;b.js"')).toEqual({ ok: true, command: 'node', args: ['a;b.js'] })
  })

  it('collapses surrounding and repeated whitespace', () => {
    expect(parseStartCommand('  npm   run  dev ')).toEqual({ ok: true, command: 'npm', args: ['run', 'dev'] })
  })

  it('rejects empty input', () => {
    expect(parseStartCommand('')).toEqual({ ok: false, error: 'Enter a start command.' })
    expect(parseStartCommand('   ')).toEqual({ ok: false, error: 'Enter a start command.' })
  })

  it('rejects unquoted shell operators', () => {
    for (const bad of [
      'npm run dev; rm -rf /',
      'a && b',
      'a | b',
      'echo $(whoami)',
      'echo `whoami`',
      'a > b',
      'a < b',
      'a\nb'
    ]) {
      expect(parseStartCommand(bad).ok).toBe(false)
    }
  })

  it('rejects a leading VAR=value env assignment', () => {
    expect(parseStartCommand('PORT=3000 npm start').ok).toBe(false)
  })

  it('rejects an unbalanced quote', () => {
    expect(parseStartCommand('node "server.js')).toEqual({ ok: false, error: 'Unbalanced quote in command.' })
  })
})
