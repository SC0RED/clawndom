import { WebSocket } from 'ws';
import { getLogger } from '../lib/logging';

const logger = getLogger('gateway-client');

export interface AgentRunResult {
  runId: string;
  status: 'ok' | 'error' | 'timeout';
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Persistent WebSocket client to the OpenClaw gateway.
 * Handles the connect handshake and exposes `agent` + `agent.wait` RPCs.
 */
export class GatewayClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly token: string;
  private requestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      const connectTimeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error('Gateway WS connect timeout (10s)'));
      }, 10_000);

      this.ws.on('open', () => {
        const connectId = this.nextId();
        this.ws!.send(
          JSON.stringify({
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              token: this.token,
              client: {
                id: 'clawndom',
                displayName: 'clawndom',
                version: '0.2.0',
                platform: 'node',
                mode: 'cli',
              },
            },
          }),
        );

        const onFirstMessage = (data: Buffer | string): void => {
          try {
            const msg = JSON.parse(String(data));
            if (msg.type === 'res' && msg.id === connectId) {
              clearTimeout(connectTimeout);
              this.ws!.removeListener('message', onFirstMessage);

              if (msg.ok) {
                this.connected = true;
                this.ws!.on('message', (d: Buffer | string) => this.handleMessage(d));
                logger.info('Gateway WS connected');
                resolve();
              } else {
                reject(new Error(`Gateway connect rejected: ${JSON.stringify(msg.error)}`));
              }
            }
          } catch (error) {
            clearTimeout(connectTimeout);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };

        this.ws!.on('message', onFirstMessage);
      });

      this.ws.on('error', (error) => {
        clearTimeout(connectTimeout);
        logger.error({ error: error.message }, 'Gateway WS error');
        reject(error);
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.rejectAllPending('Gateway WS closed');
        logger.warn('Gateway WS disconnected');
      });
    });
  }

  private nextId(): string {
    this.requestId += 1;
    return `clawndom-${this.requestId}`;
  }

  private handleMessage(data: Buffer | string): void {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === 'res' && typeof msg.id === 'string') {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.ok) {
            pending.resolve(msg.payload);
          } else {
            pending.reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
          }
        }
      }
      // Ignore events (tick, presence, etc.) — we don't need them
    } catch {
      logger.warn('Failed to parse gateway WS message');
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    await this.connect();

    const id = this.nextId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout (${timeoutMs}ms) for ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.ws!.send(
        JSON.stringify({
          type: 'req',
          id,
          method,
          params,
        }),
      );
    });
  }

  /**
   * Send a message to an agent and wait for the run to complete.
   * Returns when the agent run finishes (lifecycle end/error).
   */
  async runAndWait(
    params: {
      message: string;
      sessionKey?: string;
      agentId?: string;
      name?: string;
      model?: string;
      thinking?: string;
      deliver?: boolean;
      channel?: string;
      to?: string;
    },
    waitTimeoutMs: number,
  ): Promise<AgentRunResult> {
    // Step 1: trigger the run via `agent` RPC
    const agentResult = (await this.rpc(
      'agent',
      {
        ...params,
        idempotencyKey: `clawndom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      30_000,
    )) as { runId: string; acceptedAt: string };

    const { runId } = agentResult;
    logger.info({ runId }, 'Agent run started');

    // Step 2: wait for completion via `agent.wait` RPC
    const waitResult = (await this.rpc(
      'agent.wait',
      {
        runId,
        timeoutMs: waitTimeoutMs,
      },
      waitTimeoutMs + 10_000,
    )) as AgentRunResult;

    logger.info({ runId, status: waitResult.status }, 'Agent run completed');

    return { ...waitResult, runId };
  }

  async close(): Promise<void> {
    this.connected = false;
    this.rejectAllPending('Client closing');
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
