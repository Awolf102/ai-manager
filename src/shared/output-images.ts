// Pure filtering for the run-output image gallery. No node/DOM imports.
import { isImageName } from './context-files'

export const OUTPUT_IMAGE_MAX = 60
export const OUTPUT_IMAGE_MAX_DEPTH = 4
export const OUTPUT_IMAGE_MAX_BYTES = 2_000_000

export interface OutputImage {
  path: string // project-relative path
  dataUrl: string | null // inlined image, or null if too large to inline
}

const EXCLUDED = new Set(['node_modules', '.git', '.ai-manager', 'dist', 'out'])

/** Whether a project-relative image path should appear in the gallery. `depth` = number of
 *  path segments before the file (0 = project root). SVG is excluded (never inlined as <img src>). */
export function includeOutputImage(relPath: string, depth: number): boolean {
  if (depth > OUTPUT_IMAGE_MAX_DEPTH) return false
  const segs = relPath.split('/')
  if (segs.some((s) => EXCLUDED.has(s))) return false
  const name = segs[segs.length - 1]
  if (!isImageName(name)) return false
  return !name.toLowerCase().endsWith('.svg')
}
