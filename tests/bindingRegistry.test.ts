import { describe, expect, it } from 'vitest';
import { createBindingRegistry } from '../src/bindingRegistry';
import type { ChatSnapshot } from '../src/contracts';

function memoryArea(initial: Record<string, unknown> = {}) {
  let values = { ...initial };
  return {
    async get(key: string) { return { [key]: values[key] }; },
    async set(items: Record<string, unknown>) { values = { ...values, ...items }; },
    read: () => values,
  };
}

function snapshot(key: string, conversationId?: string): ChatSnapshot {
  return {
    conversationKey: key,
    ...(conversationId ? { conversationId } : {}),
    title: 'ChatGPT',
    url: 'https://chatgpt.com/',
    status: 'idle',
    confidence: 'direct',
    signals: ['composer-ready'],
    assistantMessageCount: 0,
    latestAssistantText: '',
    observedAt: 1,
  };
}

describe('binding registry', () => {
  it('projects multiple bindings through one serialized store scope', async () => {
    const local = memoryArea();
    const session = memoryArea({ tabs: { '7': { role: 'WORKER', project: 'P', notes: '' } } });
    const registry = createBindingRegistry(
      { local, session },
      { persistent: 'bindings', ephemeral: 'tabs' },
    );

    const roles = await registry.project((resolve) => [
      resolve(7, snapshot('conversation:abc', 'abc')).role,
      resolve(8, snapshot('url:https://chatgpt.com/')).role,
    ]);

    expect(roles).toEqual(['WORKER', '']);
    expect(local.read().bindings).toEqual({
      'conversation:abc': { role: 'WORKER', project: 'P', notes: '' },
    });
    expect(session.read().tabs).toEqual({});
  });

  it('serializes concurrent updates so ephemeral bindings cannot overwrite each other', async () => {
    const local = memoryArea();
    const session = memoryArea();
    const registry = createBindingRegistry(
      { local, session },
      { persistent: 'bindings', ephemeral: 'tabs' },
    );

    await Promise.all([
      registry.update(7, 'url:https://chatgpt.com/', { role: 'A', project: 'P', notes: '' }),
      registry.update(8, 'url:https://chatgpt.com/', { role: 'B', project: 'P', notes: '' }),
    ]);

    expect(session.read().tabs).toEqual({
      '7': { role: 'A', project: 'P', notes: '' },
      '8': { role: 'B', project: 'P', notes: '' },
    });
  });
});
