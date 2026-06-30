export default function FaqModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>How to prompt Orkestr</h2>
        <div className="faq-body">
          <p><b>Give the orchestrator a goal.</b> Describe the outcome you want in plain language in the goal box, then press Run. The orchestrator plans the work and delegates down the chain.</p>
          <p><b>Build a team first if you have none.</b> Use <i>Draft roles</i> to suggest specialists, or <i>Build team</i> to have the orchestrator design and create one for your goal.</p>
          <p><b>Wire the chain.</b> Drag from the bottom of one agent to the top of another so the upper one delegates to the lower one.</p>
          <p><b>Watch and launch.</b> The Run tab streams progress; <i>Launch app</i> starts the app your team built and opens it.</p>
          <p><b>Good goals are specific.</b> State the what and the constraints (stack, scope, must-haves); leave the how to the team.</p>
        </div>
        <div className="modal-actions"><button className="btn primary" onClick={onClose}>Got it</button></div>
      </div>
    </div>
  )
}
