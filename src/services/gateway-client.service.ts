/**
 * Minimal OpenClaw Gateway WebSocket client.
 *
 * Connects to the local gateway, authenticates via the connect handshake,
 * calls a single method, and disconnects cleanly. Intended for fire-and-forget
 * one-shot operations from the worker (e.g. sessions.send).
 */
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { getLogger } from '../lib/logging';

const logger = getLogger('gateway-client');

const PROTOCOL_VERSION = 3;
const CLIENT_ID = 'clawndom';
const CLIENT_MODE = 'operator';
const CLIENT_VERSION = '1.0.0';

/** Wire-format frames (subset we use). */
interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: number; message: string };
}

type Frame = RequestFrame | ResponseFrame | { type: string; [k: string]: unknown };

/**
 * Connect to the OpenClaw gateway WS, authenticate, call `sessions.send`,
 * then disconnect.
 */
export async function sendToSession(opts: {
  /** WebSocket URL, e.g. `ws://127.0.0.1:18789`. */
  gatewayWsUrl: string;
  /** Bearer token from OPENCLAW_TOKEN env / plist. */
  token: string;
  /** Full session key, e.g. `agent:patch:main`. */
  sessionKey: string;
  /** Rendered message to inject. */
  message: string;
  /** Optional idempotency key for deduplication. */
  idempotencyKey?: string;
  /** Connection + call timeout in ms. Default: 30_000. */
  timeoutMs?: number;
}): Promise<void> {
  const { gatewayWsUrl, token, sessionKey, message, idempotencyKey, timeoutMs = 30_000 } = opts;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(gatewayWsUrl, { handshakeTimeout: 10_000 });
    const pending = new Map<string, (frame: ResponseFrame) => void>();
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error(`Gateway WS call timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    function done(err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      ws.close();
      if (err) reject(err);
      else resolve();
    }

    function send(frame: RequestFrame): void {
      ws.send(JSON.stringify(frame));
    }

    function call(method: string, params: Record<string, unknown>): Promise<ResponseFrame> {
      return new Promise((res) => {
        const id = randomUUID();
        pending.set(id, res);
        send({ type: 'req', id, method, params });
      });
    }

    ws.on('error', (err) => done(new Error(`Gateway WS error: ${err.message}`)));

    ws.on('close', (code) => {
      if (!settled) done(new Error(`Gateway WS closed unexpectedly (code ${code})`));
    });

    ws.on('message', async (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString()) as Frame;
      } catch {
        done(new Error('Gateway WS: received non-JSON frame'));
        return;
      }

      // Route response frames to pending resolvers
      if (frame.type === 'res' && typeof (frame as ResponseFrame).id === 'string') {
        const res = frame as ResponseFrame;
        const resolver = pending.get(res.id);
        if (resolver) {
          pending.delete(res.id);
          resolver(res);
        }
        return;
      }
      // Ignore event frames (tick, presence, etc.)
    });

    ws.on('open', async () => {
      try {
        // Step 1: connect handshake
        const connectRes = await call('connect', {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: CLIENT_ID,
            mode: CLIENT_MODE,
            version: CLIENT_VERSION,
          },
          auth: { token },
        });

        if (!connectRes.ok) {
          done(
            new Error(
              `Gateway connect failed: ${connectRes.error?.message ?? JSON.stringify(connectRes.error)}`,
            ),
          );
          return;
        }

        logger.debug({ sessionKey }, 'Gateway connected — sending sessions.send');

        // Step 2: sessions.send
        const sendParams: Record<string, unknown> = { key: sessionKey, message };
        if (idempotencyKey) sendParams.idempotencyKey = idempotencyKey;

        const sendRes = await call('sessions.send', sendParams);

        if (!sendRes.ok) {
          done(
            new Error(
              `sessions.send failed: ${sendRes.error?.message ?? JSON.stringify(sendRes.error)}`,
            ),
          );
          return;
        }

        logger.debug({ sessionKey }, 'sessions.send acknowledged');
        done();
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
