import { describe, it, expect } from 'vitest'
import { detectManifestPrompt, parseManifest } from './run-manifest'

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
