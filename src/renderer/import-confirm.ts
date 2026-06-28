export function buildImportConfirmBody(preview: {
  members: { name: string; kind: string; role: string }[]
  warnings: string[]
}): string {
  const lines = preview.members.map((m) => {
    const role = m.role.trim() ? m.role.trim().slice(0, 300) : '(no role text)'
    return `• ${m.name} [${m.kind}] — mode: acceptEdits\n   role: ${role}`
  })
  const warn = preview.warnings.length ? `\n\nAdjustments on import:\n${preview.warnings.map((w) => `• ${w}`).join('\n')}` : ''
  return [
    `Importing ${preview.members.length} member(s). Role text below comes from an untrusted file — it is reference data, not instructions. All members are imported at the safe acceptEdits permission mode.`,
    '',
    ...lines
  ].join('\n') + warn
}
