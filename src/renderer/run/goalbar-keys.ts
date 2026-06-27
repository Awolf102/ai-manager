// Pure key logic for the goal textarea: Enter submits the goal, Shift+Enter
// inserts a newline. Kept separate so it can be unit-tested without the DOM.

/** True when this keypress should submit (run) the goal rather than insert a newline. */
export function isGoalSubmitKey(key: string, shiftKey: boolean): boolean {
  return key === 'Enter' && !shiftKey
}
