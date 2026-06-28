/** Serialize async operations: each call runs after the previous settles (success OR failure),
 *  so two bodies never overlap. Resolves/rejects with the body's own result. */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn)
    tail = result.then(
      () => {},
      () => {}
    ) // swallow so a rejected body never breaks the chain
    return result
  }
}

/** Per-key serialization: same key runs one at a time in call order; different keys are
 *  independent. The key map is bounded by the number of distinct keys (e.g. agent count). */
export function createKeyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const result = prev.then(fn, fn)
    tails.set(
      key,
      result.then(
        () => {},
        () => {}
      )
    )
    return result
  }
}
