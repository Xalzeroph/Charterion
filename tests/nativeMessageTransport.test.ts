import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeMessageTransport, type NativeMessagePort } from '../src/nativeMessageTransport';

class FakeEvent<T> {
  private readonly listeners: Array<(value: T) => void> = [];
  addListener(listener: (value: T) => void): void { this.listeners.push(listener); }
  emit(value: T): void { for (const listener of this.listeners) listener(value); }
}

class FakePort implements NativeMessagePort {
  readonly posted: unknown[] = [];
  readonly onMessage = new FakeEvent<unknown>();
  readonly onDisconnect = new FakeEvent<void>();
  disconnectCalls = 0;
  postError: Error | undefined;

  postMessage(message: unknown): void {
    if (this.postError) throw this.postError;
    this.posted.push(message);
  }

  disconnect(): void { this.disconnectCalls += 1; }
}

afterEach(() => vi.useRealTimers());

describe('NativeMessageTransport', () => {
  it('reuses one native host connection and correlates out-of-order replies', async () => {
    const ports: FakePort[] = [];
    const transport = new NativeMessageTransport('host', () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    }, () => undefined, -1);

    const first = transport.request({ id: 'a', method: 'one' });
    const second = transport.request({ id: 'b', method: 'two' });
    expect(ports).toHaveLength(1);
    expect(ports[0]!.posted).toHaveLength(2);

    ports[0]!.onMessage.emit({ id: 'b', ok: true, result: 2 });
    ports[0]!.onMessage.emit({ id: 'a', ok: true, result: 1 });
    await expect(first).resolves.toMatchObject({ id: 'a', result: 1 });
    await expect(second).resolves.toMatchObject({ id: 'b', result: 2 });
  });

  it('rejects only disconnected-port requests and reconnects on the next request', async () => {
    const ports: FakePort[] = [];
    let reason = 'native host exited';
    const transport = new NativeMessageTransport('host', () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    }, () => reason, -1);

    const first = transport.request({ id: 'a' });
    ports[0]!.onDisconnect.emit(undefined);
    await expect(first).rejects.toThrow('native host exited');

    reason = 'second host exited';
    const second = transport.request({ id: 'b' });
    expect(ports).toHaveLength(2);
    ports[1]!.onMessage.emit({ id: 'b', ok: true });
    await expect(second).resolves.toMatchObject({ id: 'b' });
  });

  it('fails closed on malformed uncorrelatable responses', async () => {
    const port = new FakePort();
    const transport = new NativeMessageTransport('host', () => port, () => undefined, -1);
    const pending = transport.request({ id: 'a' });
    port.onMessage.emit({ ok: true });
    await expect(pending).rejects.toThrow(/missing its request id/i);
    expect(port.disconnectCalls).toBe(1);
  });

  it('drops an idle connection so the extension worker is not pinned forever', async () => {
    vi.useFakeTimers();
    const ports: FakePort[] = [];
    const transport = new NativeMessageTransport('host', () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    }, () => undefined, 1_000);

    const first = transport.request({ id: 'a' });
    ports[0]!.onMessage.emit({ id: 'a', ok: true });
    await first;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ports[0]!.disconnectCalls).toBe(1);

    const second = transport.request({ id: 'b' });
    expect(ports).toHaveLength(2);
    ports[1]!.onMessage.emit({ id: 'b', ok: true });
    await second;
  });
});
