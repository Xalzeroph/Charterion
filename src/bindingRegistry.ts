import { createBindingStore } from './bindingStore';
import type { ChatSnapshot, RoleBinding } from './contracts';
import { MutationLane } from './mutationLane';

type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

type BindingStorage = { local: StorageArea; session: StorageArea };
type BindingKeys = { persistent: string; ephemeral: string };
type BindingResolver = (tabId: number, snapshot: ChatSnapshot) => RoleBinding;

export function createBindingRegistry(storage: BindingStorage, keys: BindingKeys) {
  const store = createBindingStore(storage, keys);
  const lane = new MutationLane();

  function run<T>(operation: () => Promise<T>): Promise<T> {
    return lane.run(operation);
  }

  async function resolve(tabId: number, snapshot: ChatSnapshot): Promise<RoleBinding> {
    return run(async () => {
      const stores = await store.read();
      const binding = store.resolve(tabId, snapshot, stores);
      await store.persist(stores);
      return binding;
    });
  }

  async function project<T>(operation: (resolveBinding: BindingResolver) => T | Promise<T>): Promise<T> {
    return run(async () => {
      const stores = await store.read();
      const result = await operation((tabId, snapshot) => store.resolve(tabId, snapshot, stores));
      await store.persist(stores);
      return result;
    });
  }

  function update(tabId: number, conversationKey: string, binding: RoleBinding): Promise<void> {
    return run(() => store.update(tabId, conversationKey, binding));
  }

  function clear(conversationKey: string | undefined, tabId: number | undefined): Promise<void> {
    return run(() => store.clear(conversationKey, tabId));
  }

  function readPersistent(): Promise<Record<string, RoleBinding>> {
    return run(() => store.readPersistent());
  }

  return {
    run,
    resolve,
    project,
    update,
    clear,
    readPersistent,
    waitForIdle: () => lane.waitForIdle(),
  };
}
