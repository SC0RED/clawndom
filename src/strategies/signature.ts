import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureStrategy {
  readonly headerName: string;
  validate(rawBody: Buffer, signatureHeader: string, secret: string): boolean;
}

function validateHmacSha256(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const receivedHex = signatureHeader.slice(expectedPrefix.length);
  const computedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

  const receivedBuffer = Buffer.from(receivedHex, 'hex');
  const computedBuffer = Buffer.from(computedHex, 'hex');

  if (receivedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, computedBuffer);
}

/**
 * WebSub format used by Jira Cloud.
 * Header: X-Hub-Signature
 * Value: sha256=<hex>
 */
export const websubStrategy: SignatureStrategy = {
  headerName: 'x-hub-signature',
  validate: validateHmacSha256,
};

/**
 * GitHub webhook format.
 * Header: X-Hub-Signature-256
 * Value: sha256=<hex>
 */
export const githubStrategy: SignatureStrategy = {
  headerName: 'x-hub-signature-256',
  validate: validateHmacSha256,
};

const strategies: Record<string, SignatureStrategy> = {
  websub: websubStrategy,
  github: githubStrategy,
};

export function getSignatureStrategy(name: string): SignatureStrategy {
  const strategy = strategies[name];
  if (!strategy) {
    throw new Error(
      `Unknown signature strategy: ${name}. Valid strategies: ${Object.keys(strategies).join(', ')}`,
    );
  }
  return strategy;
}
