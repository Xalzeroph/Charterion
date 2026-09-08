export class TabOperationQueue {
  private readonly tails = new Map<number, Promise<void>>();

  run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(tabId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    this.tails.set(tabId, settled);

    void settled.finally(() => {
      if (this.tails.get(tabId) === settled) this.tails.delete(tabId);
    });
    return run;
  }

  pending(tabId: number): boolean {
    return this.tails.has(tabId);
  }
}
