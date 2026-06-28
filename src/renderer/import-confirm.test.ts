import { describe, it, expect } from 'vitest'
import { buildImportConfirmBody } from './import-confirm'

it('lists members, forced mode, and warnings; flags role text as untrusted', () => {
  const body = buildImportConfirmBody(
    { members: [{ name: 'A', kind: 'worker', role: 'do x' }], warnings: ['A: role truncated'] }
  )
  expect(body).toContain('A')
  expect(body).toContain('worker')
  expect(body).toContain('acceptEdits')
  expect(body).toContain('A: role truncated')
  expect(body.toLowerCase()).toContain('untrusted')
})
