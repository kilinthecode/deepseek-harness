/** One reporter's on-demand import of its OTLP SDK graph. */

/**
 * At most one in-flight import per reporter. A failed import is reported through
 * `onFailure` and retried by the next {@link SdkLoad.start}; the settlement a
 * caller awaits never rejects.
 */
export class SdkLoad<Sdk> {
  private inFlight: Promise<void> | undefined

  /**
   * @param load - the shared, memoized SDK import.
   * @param onFailure - receives a failed import as an Error.
   */
  constructor(
    private readonly load: () => Promise<Sdk>,
    private readonly onFailure: (error: Error) => void,
  ) {}

  /** Whether an import this reporter started has not settled yet. */
  get pending(): boolean {
    return this.inFlight !== undefined
  }

  /**
   * Start the import unless one is already in flight.
   * @param loaded - runs with the SDK once imported, before the settlement resolves.
   */
  start(loaded: (sdk: Sdk) => void): void {
    if (this.inFlight !== undefined) return
    this.inFlight = this.load().then((sdk) => {
      this.inFlight = undefined
      loaded(sdk)
    }, (error: unknown) => {
      this.inFlight = undefined
      this.onFailure(error instanceof Error ? error : new Error(String(error)))
    })
  }

  /**
   * Await the import this reporter started, if any.
   * @returns settlement of the in-flight import, or an already resolved promise; never rejects.
   */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }
}
