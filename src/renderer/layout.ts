export type InspectorPlacement = 'left' | 'right'
export type DockPlacement = 'bottom' | 'right'

export interface LayoutState {
  inspector: { size: number; collapsed: boolean; placement: InspectorPlacement }
  dock: { size: number; collapsed: boolean; placement: DockPlacement }
}

export const DEFAULT_LAYOUT: LayoutState = {
  inspector: { size: 348, collapsed: false, placement: 'right' },
  dock: { size: 300, collapsed: false, placement: 'bottom' }
}

const clamp = (px: number, min: number, max: number): number => Math.max(min, Math.min(max, px))

export const clampInspector = (px: number): number => clamp(px, 280, 560)
export const clampDockHeight = (px: number, viewportH: number): number => clamp(px, 160, Math.round(viewportH * 0.6))
export const clampDockWidth = (px: number): number => clamp(px, 240, 640)

export function computeBodyGrid(layout: LayoutState): { columns: string; rows: string; areas: string } {
  const insW = layout.inspector.collapsed ? '0px' : `${layout.inspector.size}px`
  const dockBottomH = layout.dock.collapsed ? '0px' : `${layout.dock.size}px`
  const dockRightW = layout.dock.collapsed ? '0px' : `${layout.dock.size}px`
  const insLeft = layout.inspector.placement === 'left'
  const dockRight = layout.dock.placement === 'right'

  if (dockRight && insLeft) {
    return { columns: `${insW} 1fr ${dockRightW}`, rows: '1fr', areas: '"inspector main dock"' }
  }
  if (dockRight && !insLeft) {
    // both right: right column stacks inspector (top) over dock (bottom); column width = inspector's
    return { columns: `1fr ${insW}`, rows: `1fr ${dockBottomH}`, areas: '"main inspector" "main dock"' }
  }
  // dock bottom
  if (insLeft) {
    return { columns: `${insW} 1fr`, rows: `1fr ${dockBottomH}`, areas: '"inspector main" "inspector dock"' }
  }
  return { columns: `1fr ${insW}`, rows: `1fr ${dockBottomH}`, areas: '"main inspector" "dock inspector"' }
}

export function serializeLayout(s: LayoutState): string {
  return JSON.stringify(s)
}

export function parseLayout(raw: string | null): LayoutState {
  if (!raw) return DEFAULT_LAYOUT
  try {
    const o = JSON.parse(raw) as Partial<LayoutState>
    return {
      inspector: { ...DEFAULT_LAYOUT.inspector, ...(o.inspector ?? {}) },
      dock: { ...DEFAULT_LAYOUT.dock, ...(o.dock ?? {}) }
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}
