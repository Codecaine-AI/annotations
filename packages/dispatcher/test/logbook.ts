/** The dispatcher's log lines, for tests that wait on what it decided without a store change to show for it. */
export class Logbook {
  readonly lines: string[] = [];
  private waiters: { predicate: () => boolean; resolve: () => void }[] = [];

  readonly log = (line: string): void => {
    this.lines.push(line);
    const ready = this.waiters.filter((waiter) => waiter.predicate());
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
  };

  /** How many lines contain `text`. */
  count(text: string): number {
    return this.lines.filter((line) => line.includes(text)).length;
  }

  /** Resolves when `predicate` holds, checked now and after every line. */
  whenever(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }
}
