// Pure helpers + built-in preset templates for model backends (no node/DOM imports).
import type { BackendModel } from './types'

export interface BackendPreset {
  presetId: string // 'zai-glm' | 'chatgpt-gateway' | 'custom'
  label: string
  baseUrl: string // '' when the user must supply it
  gateway?: boolean // true ⇒ baseUrl is a user-supplied Anthropic→OpenAI proxy
  models: BackendModel[]
}

export const BACKEND_PRESETS: BackendPreset[] = [
  {
    presetId: 'zai-glm',
    label: 'z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air' }
    ]
  },
  {
    presetId: 'chatgpt-gateway',
    label: 'ChatGPT (via gateway)',
    baseUrl: '',
    gateway: true,
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
  },
  { presetId: 'custom', label: 'Custom', baseUrl: '', models: [] }
]

/** The env vars that route a Claude-SDK run to an Anthropic-compatible backend. */
export function backendEnv(baseUrl: string, token: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token }
}

/** Parse a comma/newline model-id list into BackendModel[]. Each entry is `id` or `id|Label`. */
export function parseModelIds(text: string): BackendModel[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const [id, label] = entry.split('|').map((p) => p.trim())
      return { id, label: label || id }
    })
}
