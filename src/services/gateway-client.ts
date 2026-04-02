import { GatewayClient as SdkGatewayClient } from 'openclaw/plugin-sdk/gateway-runtime';
import { getLogger } from '../lib/logging';

const logger = getLogger('gateway-client');

export interface AgentRunResult {
  runId: string;
  status: 'ok' | 'error' | 'timeout';
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

/**
 * Persistent WebSocket client to the OpenClaw gateway.
 * Wraps the official SDK GatewayClient which handles device identity,
 * scope negotiation, reconnection, and the full connect handshake.
 */
export class GatewayClient {
  private client: SdkGatewayClient;
  private started = false;

  constructor(url: string, token: string) {
    this.client = new SdkGatewayClient({
      url,
      token,
      clientName: 'gateway-client',
      clientDisplayName: 'clawndom',
      clientVersion: '0.2.0',
      platform: 'node',
      mode: 'backend',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      // deviceIdentity auto-loaded by SDK via loadOrCreateDeviceIdentity()
      onEvent: (): void => {}, // ignore events (tick, presence)
      onHelloOk: (): void => {
        logger.info('Gateway WS connected');
      },
      onConnectError: (err: Error): void => {
        logger.error({ error: err.message }, 'Gateway WS connect error');
      },
      onClose: (_code: number, reason: string): void => {
        logger.warn({ reason }, 'Gateway WS disconnected');
      },
    });
  }

  async connect(): Promise<void> {
    if (!this.started) {
      this.client.start();
      this.started = true;
      // Give the SDK client time to complete the handshake
      // The SDK handles reconnection internally
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
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
    await this.connect();

    // Step 1: trigger the run via `agent` RPC
    const agentResult = await this.client.request<{ runId: string; acceptedAt: string }>('agent', {
      ...params,
      idempotencyKey: `clawndom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    const { runId } = agentResult;
    logger.info({ runId }, 'Agent run started');

    // Step 2: wait for completion via `agent.wait` RPC
    const waitResult = await this.client.request<AgentRunResult>(
      'agent.wait',
      {
        runId,
        timeoutMs: waitTimeoutMs,
      },
      { timeoutMs: waitTimeoutMs + 10_000 },
    );

    logger.info({ runId, status: waitResult.status }, 'Agent run completed');

    return { ...waitResult, runId };
  }

  async close(): Promise<void> {
    this.client.stop();
    this.started = false;
  }
}
