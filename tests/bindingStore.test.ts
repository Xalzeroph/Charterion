import { describe, expect, it } from 'vitest';
import { createBindingStore } from '../src/bindingStore';

function memoryArea(initial: Record<string, unknown> = {}) {
  let values = { ...initial };
  let writes = 0;
  return {
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (items: Record<string, unknown>) => {
      values = { ...values, ...items };
      writes += 1;
    },
    read: () => values,
    writes: () => writes,
  };
}

const snapshot = (conversationKey: string, conversationId?: string) => ({
  conversationKey,
  ...(conversationId ? { conversationId } : {}),
  title: 'ChatGPT',
  url: 'https://chatgpt.com/',
  status: 'idle' as const,
  confidence: 'direct' as const,
  signals: [],
  assistantMessageCount: 0,
  latestAssistantText: '',
  observedAt: 1,
});

describe('binding store', () => {
  it('reads persistent and ephemeral bindings together and resolves durable identity first', async () => {
    const local = memoryArea({ bindings: { 'conversation:one': { role: 'A', project: 'P', notes: '' } } });
    const session = memoryArea({ tabs: { '7': { role: 'B', project: 'P', notes: '' } } });
    const store = createBindingStore({ local, session }, { persistent: 'bindings', ephemeral: 'tabs' });
    const stores = await store.read();

    expect(store.resolve(7, snapshot('conversation:one', 'one'), stores).role).toBe('A');
    expect(local.writes()).toBe(0);
    expect(session.writes()).toBe(0);
  });

  it('migrates a temporary tab binding once and persists both maps together', async () => {
    const local = memoryArea();
    const session = memoryArea({ tabs: { '7': { role: 'B', project: 'P', notes: '' } } });
    const store = createBindingStore({ local, session }, { persistent: 'bindings', ephemeral: 'tabs' });
    const stores = await store.read();

    expect(store.resolve(7, snapshot('conversation:two', 'two'), stores).role).toBe('B');
    await store.persist(stores);

    expect(local.read().bindings).toEqual({ 'conversation:two': { role: 'B', project: 'P', notes: '' } });
    expect(session.read().tabs).toEqual({});
    expect(local.writes()).toBe(1);
    expect(session.writes()).toBe(1);
  });

  it('writes only session storage for provisional binding updates', async () => {
    const local = memoryArea({ bindings: { 'conversation:one': { role: 'Old', project: 'P', notes: '' } } });
    const session = memoryArea();
    const store = createBindingStore({ local, session }, { persistent: 'bindings', ephemeral: 'tabs' });
    const binding = { role: 'A', project: 'P', notes: '' };

    await store.update(7, 'url:https://chatgpt.com/', binding);

    expect(session.read().tabs).toEqual({ '7': binding });
    expect(local.writes()).toBe(0);
    expect(session.writes()).toBe(1);
  });

  it('does not rewrite session storage when a canonical update has no temporary binding', async () => {
    const local = memoryArea();
    const session = memoryArea({ tabs: {} });
    const store = createBindingStore({ local, session }, { persistent: 'bindings', ephemeral: 'tabs' });
    const binding = { role: 'A', project: 'P', notes: '' };

    await store.update(7, 'conversation:two', binding);

    expect(local.read().bindings).toEqual({ 'conversation:two': binding });
    expect(local.writes()).toBe(1);
    expect(session.writes()).toBe(0);
  });

  it('clears only stores that actually contain the requested binding', async () => {
    const local = memoryArea({ bindings: { 'conversation:two': { role: 'A', project: 'P', notes: '' } } });
    const session = memoryArea({ tabs: {} });
    const store = createBindingStore({ local, session }, { persistent: 'bindings', ephemeral: 'tabs' });

    await store.clear('conversation:two', 7);

    expect(local.read().bindings).toEqual({});
    expect(local.writes()).toBe(1);
    expect(session.writes()).toBe(0);
    await store.clear('conversation:missing', 99);
    expect(local.writes()).toBe(1);
    expect(session.writes()).toBe(0);
  });

  it('preserves update and clear semantics through the adapter API', async () => {
    const local = memoryArea();
    const session = memoryArea();
    const store = createBindingStore({ local, session }, { persistent: 'bindings', ephemeral: 'tabs' });
    const binding = { role: 'A', project: 'P', notes: '' };

    await store.update(7, 'url:https://chatgpt.com/', binding);
    expect(session.read().tabs).toEqual({ '7': binding });

    await store.update(7, 'conversation:two', binding);
    expect(local.read().bindings).toEqual({ 'conversation:two': binding });
    expect(session.read().tabs).toEqual({});

    await store.clear('conversation:two', 7);
    expect(local.read().bindings).toEqual({});
    expect(session.read().tabs).toEqual({});
  });
});
