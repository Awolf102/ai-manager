export default function CanvasLegend() {
  return (
    <div className="canvas-legend">
      <div className="legend-row"><span className="legend-line report" /> reports to</div>
      <div className="legend-row"><span className="legend-line handoff" /> handoff</div>
      <div className="legend-row"><span className="legend-badge">1</span> run order</div>
      <div className="legend-hint">Drag a node's bottom → another's top to connect</div>
    </div>
  )
}
