import { EMPTY_BINDING, type ChatSnapshot, type RoleBinding } from './contracts';

type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type BindingStores = {
  persistent: Record<string, RoleBinding>;
  ephemeral: Record<string, RoleBinding>;
  dirty: boolean;
};

export type BindingStore = ReturnType<typeof createBindingStore>;

type BindingStorage = {
  local: StorageArea;
  session: StorageArea;
};

type BindingKeys = {
  persistent: string;
  ephemeral: string;
};

function parseBinding(value: unknown): RoleBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.role !== 'string' || typeof item.project !== 'string' || typeof item.notes !== 'string') return undefined;
  if (item.agentSlotId !== undefined && typeof item.agentSlotId !== 'string') return undefined;
  return {
    role: item.role,
    project: item.project,
    notes: item.notes,
    ...(typeof item.agentSlotId === 'string' ? { agentSlotId: item.agentSlotId } : {}),
  };
}

function parseBindingMap(value: unknown): Record<string, RoleBinding> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, RoleBinding> = {};
  for (const [key, raw] of Object.entries(value)) {
    const binding = parseBinding(raw);
    if (binding) result[key] = binding;
  }
  return result;
}

export function createBindingStore(storage: BindingStorage, keys: BindingKeys) {
  async function readPersistent(): Promise<Record<string, RoleBinding>> {
    const stored = await storage.local.get(keys.persistent);
    return parseBindingMap(stored[keys.persistent]);
  }

  async function readEphemeral(): Promise<Record<string, RoleBinding>> {
    const stored = await storage.session.get(keys.ephemeral);
    return parseBindingMap(stored[keys.ephemeral]);
  }

  async function read(): Promise<BindingStores> {
    const [persistent, ephemeral] = await Promise.all([readPersistent(), readEphemeral()]);
    return { persistent, ephemeral, dirty: false };
  }

  async function writePersistent(bindings: Record<string, RoleBinding>): Promise<void> {
    await storage.local.set({ [keys.persistent]: bindings });
  }

  async function writeEphemeral(bindings: Record<string, RoleBinding>): Promise<void> {
    await storage.session.set({ [keys.ephemeral]: bindings });
  }

  function resolve(tabId: number, snapshot: ChatSnapshot, stores: BindingStores): RoleBinding {
    const durable = stores.persistent[snapshot.conversationKey];
    if (durable) return durable;
    const temporary = stores.ephemeral[String(tabId)];
    if (!temporary) return { ...EMPTY_BINDING };
    if (snapshot.conversationId) {
      stores.persistent[snapshot.conversationKey] = temporary;
      delete stores.ephemeral[String(tabId)];
      stores.dirty = true;
    }
    return temporary;
  }

  async function persist(stores: BindingStores): Promise<void> {
    if (!stores.dirty) return;
    await Promise.all([writePersistent(stores.persistent), writeEphemeral(stores.ephemeral)]);
    stores.dirty = false;
  }

  async function update(tabId: number, conversationKey: string, binding: RoleBinding): Promise<void> {
    const tabKey = String(tabId);
    if (!conversationKey.startsWith('conversation:')) {
      const ephemeral = await readEphemeral();
      ephemeral[tabKey] = binding;
      await writeEphemeral(ephemeral);
      return;
    }

    const [persistent, ephemeral] = await Promise.all([readPersistent(), readEphemeral()]);
    persistent[conversationKey] = binding;
    const hadTemporary = Object.hasOwn(ephemeral, tabKey);
    if (hadTemporary) delete ephemeral[tabKey];
    await Promise.all([
      writePersistent(persistent),
      ...(hadTemporary ? [writeEphemeral(ephemeral)] : []),
    ]);
  }

  async function clear(conversationKey: string | undefined, tabId: number | undefined): Promise<void> {
    const [persistent, ephemeral] = await Promise.all([readPersistent(), readEphemeral()]);
    const persistentChanged = Boolean(conversationKey && Object.hasOwn(persistent, conversationKey));
    const tabKey = tabId === undefined ? undefined : String(tabId);
    const ephemeralChanged = Boolean(tabKey !== undefined && Object.hasOwn(ephemeral, tabKey));
    if (conversationKey && persistentChanged) delete persistent[conversationKey];
    if (tabKey !== undefined && ephemeralChanged) delete ephemeral[tabKey];
    await Promise.all([
      ...(persistentChanged ? [writePersistent(persistent)] : []),
      ...(ephemeralChanged ? [writeEphemeral(ephemeral)] : []),
    ]);
  }

  return {
    readPersistent,
    readEphemeral,
    read,
    writePersistent,
    writeEphemeral,
    resolve,
    persist,
    update,
    clear,
  };
}
