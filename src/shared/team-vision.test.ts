import { describe, it, expect } from 'vitest'
import { VISION_TEAM, visionBias } from './team-vision'
import { briefTeamToSpawnedMembers } from './advisor'

describe('team-vision', () => {
  it('visionBias names the creative orientation', () => {
    const b = visionBias()
    expect(b).toMatch(/creative|design/i)
    expect(b.length).toBeGreaterThan(40)
  })
  it('VISION_TEAM is a 7-member creative agency under one Creative Director', () => {
    expect(VISION_TEAM).toHaveLength(7)
    const lead = VISION_TEAM.find((m) => m.kind === 'manager')
    expect(lead?.name).toBe('Creative Director')
    // every worker reports to the Creative Director; the lead reports to orchestrator
    const workers = VISION_TEAM.filter((m) => m.kind === 'worker')
    expect(workers).toHaveLength(6)
    expect(workers.every((w) => w.reportsTo === 'Creative Director')).toBe(true)
    expect(lead?.reportsTo).toBe('orchestrator')
  })
  it('maps cleanly to SpawnedMember[] with reportsTo resolving', () => {
    const members = briefTeamToSpawnedMembers(VISION_TEAM)
    expect(members).toHaveLength(7)
    const lead = members.find((m) => m.name === 'Creative Director')!
    expect(lead.reportsTo).toBe('orchestrator')
    // a worker resolves to the lead's temp id
    const worker = members.find((m) => m.name === 'Copywriter')!
    expect(worker.reportsTo).toBe(lead.id)
  })
})
