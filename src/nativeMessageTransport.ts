export interface NativeMessageRequest {
  id: string;
  [key: string]: unknown;
}

interface NativeMessageEvent<T> {
  addListener(listener: (value: T) => void): void;
}

export interface NativeMessagePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativeMessageEvent<unknown>;
  onDisconnect: NativeMessageEvent<void>;
}

export type NativeMessageConnector = (host: string) => NativeMessagePort;

interface PendingRequest {
  port: NativeMessagePort;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function responseId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id ? id : undefined;
}

export class NativeMessageTransport {
  private port: NativeMessagePort | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: string,
    private readonly connect: NativeMessageConnector,
    private readonly disconnectReason: () => string | undefined = () => undefined,
    private readonly idleDisconnectMs = 30_000,
  ) {}

  request(request: NativeMessageRequest): Promise<unknown> {
    if (!request.id.trim()) return Promise.reject(new Error('Native request id is required'));
    if (this.pending.has(request.id)) return Promise.reject(new Error(`Native request ${request.id} is already pending`));

    let port: NativeMessagePort;
    try {
      port = this.ensurePort();
    } catch (error) {
      return Promise.reject(errorValue(error));
    }
    this.cancelIdleDisconnect();

    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { port, resolve, reject });
      try {
        port.postMessage(request);
      } catch (error) {
        this.pending.delete(request.id);
        const failure = errorValue(error);
        this.invalidate(port, failure);
        reject(failure);
      }
    });
  }

  disconnect(): void {
    const port = this.port;
    this.port = undefined;
    this.cancelIdleDisconnect();
    if (!port) return;
    this.rejectPort(port, new Error('Native messaging transport disconnected'));
    try { port.disconnect(); } catch { /* already disconnected */ }
  }

  private ensurePort(): NativeMessagePort {
    if (this.port) return this.port;
    const port = this.connect(this.host);
    this.port = port;
    port.onMessage.addListener((message) => this.handleMessage(port, message));
    port.onDisconnect.addListener(() => this.handleDisconnect(port));
    return port;
  }

  private handleMessage(port: NativeMessagePort, message: unknown): void {
    const id = responseId(message);
    if (!id) {
      this.invalidate(port, new Error('Native response is missing its request id'));
      return;
    }
    const pending = this.pending.get(id);
    if (!pending || pending.port !== port) return;
    this.pending.delete(id);
    pending.resolve(message);
    this.scheduleIdleDisconnect(port);
  }

  private handleDisconnect(port: NativeMessagePort): void {
    const reason = this.disconnectReason() ?? 'Native messaging port disconnected';
    this.invalidate(port, new Error(reason), false);
  }

  private invalidate(port: NativeMessagePort, error: Error, disconnect = true): void {
    if (this.port === port) this.port = undefined;
    this.cancelIdleDisconnect();
    this.rejectPort(port, error);
    if (disconnect) {
      try { port.disconnect(); } catch { /* already disconnected */ }
    }
  }

  private rejectPort(port: NativeMessagePort, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.port !== port) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private scheduleIdleDisconnect(port: NativeMessagePort): void {
    if (this.port !== port || this.hasPendingForPort(port) || this.idleDisconnectMs < 0) return;
    this.cancelIdleDisconnect();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.port !== port || this.hasPendingForPort(port)) return;
      this.port = undefined;
      try { port.disconnect(); } catch { /* already disconnected */ }
    }, this.idleDisconnectMs);
  }

  private hasPendingForPort(port: NativeMessagePort): boolean {
    for (const pending of this.pending.values()) {
      if (pending.port === port) return true;
    }
    return false;
  }

  private cancelIdleDisconnect(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

const transports = new Map<string, NativeMessageTransport>();

export function sendPersistentNativeMessage(host: string, request: NativeMessageRequest): Promise<unknown> {
  let transport = transports.get(host);
  if (!transport) {
    transport = new NativeMessageTransport(
      host,
      (name) => chrome.runtime.connectNative(name) as unknown as NativeMessagePort,
      () => chrome.runtime.lastError?.message,
    );
    transports.set(host, transport);
  }
  return transport.request(request);
}
