import { describe, it, expect } from 'vitest'
import { includeOutputImage, OUTPUT_IMAGE_MAX_DEPTH } from './output-images'

describe('includeOutputImage', () => {
  it('includes raster images within the depth bound', () => {
    expect(includeOutputImage('designs/hero.png', 1)).toBe(true)
    expect(includeOutputImage('logo.jpg', 0)).toBe(true)
  })
  it('excludes non-images and svg', () => {
    expect(includeOutputImage('notes.md', 0)).toBe(false)
    expect(includeOutputImage('icon.svg', 0)).toBe(false) // svg never inlined (security, mirrors contextThumbnail)
  })
  it('excludes build/vcs/app dirs and beyond the depth bound', () => {
    expect(includeOutputImage('node_modules/x/a.png', 1)).toBe(false)
    expect(includeOutputImage('.git/a.png', 1)).toBe(false)
    expect(includeOutputImage('.ai-manager/context/a.png', 1)).toBe(false)
    expect(includeOutputImage('dist/a.png', 1)).toBe(false)
    expect(includeOutputImage('out/a.png', 1)).toBe(false)
    expect(includeOutputImage('a/b/c/d/e/deep.png', OUTPUT_IMAGE_MAX_DEPTH + 1)).toBe(false)
  })
})
