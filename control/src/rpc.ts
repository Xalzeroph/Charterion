import { createHash, timingSafeEqual } from 'node:crypto';
import type { ControlPlane } from './controlPlane';
import type { RpcFailure, RpcRequest, RpcResponse } from './contracts';
import { enumParam, numberParam, objectArrayParam, objectParam, record, stringParam } from './rpcParams';
import { RpcRouter as LegacyRpcRouter } from './rpcLegacy';

export * from './rpcLegacy';

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function failure(id: string, code: string, message: string): RpcFailure {
  return { id, ok: false, error: { code, message } };
}

export class RpcRouter {
  private readonly legacy: LegacyRpcRouter;

  constructor(
    private readonly plane: ControlPlane,
    adminToken: string,
    private readonly browserToken: string,
    private readonly instanceId?: string,
  ) {
    this.legacy = new LegacyRpcRouter(plane, adminToken, browserToken, instanceId);
  }

  handle(request: RpcRequest): RpcResponse {
    if (request?.method !== 'work.batch-mutate') return this.legacy.handle(request);
    const id = typeof request?.id === 'string' && request.id ? request.id : 'unknown';
    try {
      if (this.instanceId && request.instanceId !== this.instanceId) {
        return failure(id, 'INSTANCE_MISMATCH', `RPC instance mismatch: expected ${this.instanceId}`);
      }
      const token = request.auth?.browserToken;
      if (!token || !safeEqual(token, this.browserToken)) throw new Error('Browser authentication failed');
      const params = record(request.params);
      const mutations = objectArrayParam(params, 'mutations').map((mutation) => ({
        kind: enumParam(mutation, 'kind', ['task', 'attempt', 'message'] as const)!,
        document: objectParam(mutation, 'document')!,
      }));
      return {
        id,
        ok: true,
        result: this.plane.work.batchUpsert({
          expectedRevision: numberParam(params, 'expectedRevision')!,
          transportGeneration: stringParam(params, 'transportGeneration')!,
          transportSequence: numberParam(params, 'transportSequence')!,
          transportMessageId: stringParam(params, 'transportMessageId')!,
          mutations,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unauthorized = /authentication|Capability token/i.test(message);
      const clientFault = /required|invalid|must be|cannot|does not|not found|conflict|stale|unsupported|already|missing|rejected|task|attempt|message|work state|sequence|batch/i.test(message);
      const code = unauthorized ? 'UNAUTHORIZED' : clientFault ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      return failure(id, code, code === 'INTERNAL_ERROR' ? 'Internal control-plane error' : message);
    }
  }
}
