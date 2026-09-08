export type ScheduledTriggerMode = 'replace' | 'keep';

type TimerHandle = ReturnType<typeof setTimeout>;

export class ScheduledTrigger {
  private timer: TimerHandle | undefined;

  constructor(
    private readonly action: () => void,
    private readonly mode: ScheduledTriggerMode = 'replace',
  ) {}

  schedule(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Scheduled trigger delay must be non-negative');
    if (this.timer !== undefined) {
      if (this.mode === 'keep') return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.action();
    }, delayMs);
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }
}
