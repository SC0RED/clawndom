import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  createMCPTestWorkspace,
  driveMCPServer,
  stageMCPFixtures,
  type MCPTestWorkspace,
  type MCPResponse,
} from './_mcp-test-harness';

/**
 * The MCP bridge forwards a tool's `__mcp_content__` block list as the tool
 * result's `content` array (text + image), so a downloaded image actually
 * reaches the multimodal model — instead of being JSON-stringified into a
 * single text block. The audit must summarize image blocks (mimeType + byte
 * count) so base64 never lands in the log.
 */
interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  bytes?: number;
}
interface ToolsCallResult {
  content: ContentBlock[];
  isError: boolean;
}
interface AuditRecord {
  tool_name: string;
  result_summary: ContentBlock[] | unknown;
  error_summary: string | null;
}

const FAKE_IMAGE = Buffer.from('not-really-a-png-but-bytes').toString('base64');

describe('MCP bridge — image content blocks (spawned Python server)', () => {
  let ws: MCPTestWorkspace;
  let toolConfigPath: string;
  let auditPath: string;

  beforeEach(async () => {
    ws = await createMCPTestWorkspace('mcp-image');
    ({ toolConfigPath, auditPath } = await stageMCPFixtures(ws.workDir, 'fixture_img_pkg', [
      {
        toolSegment: 'viewfile',
        apiName: 'fixture_viewfile',
        description: 'Return a text note plus an image block for the model to view',
        args: { value: { type: 'string', description: 'caption' } },
        secrets: [{ canonical: 'api_token', aliases: ['API_TOKEN'] }],
        implPy: `def invoke(*, value, api_token):
    return {"__mcp_content__": [
        {"type": "text", "text": "downloaded " + value + " token=" + api_token[:4]},
        {"type": "image", "data": "${FAKE_IMAGE}", "mimeType": "image/png"},
    ]}
`,
      },
    ]));
  });

  afterEach(async () => {
    await ws.cleanup();
  });

  async function drive(frames: readonly object[]): Promise<MCPResponse[]> {
    const { responses, stderr } = await driveMCPServer({
      toolConfigPath,
      auditPath,
      workDir: ws.workDir,
      agentId: 'test-winston',
      routeId: 'slack-winston:chat',
      requestId: 'req-img-1',
      toolCredentials: { fixture_viewfile: { api_token: 'super-secret-12345' } },
      frames,
    });
    if (responses.length === 0 && stderr.length > 0) {
      throw new Error(`MCP server emitted no responses. stderr: ${stderr}`);
    }
    return responses;
  }

  it('forwards text+image blocks as the tool result content array', async () => {
    const responses = await drive([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'fixture_viewfile', arguments: { value: 'bill.png' } },
      },
    ]);
    const call = responses.find((r) => r.id === 2)?.result as ToolsCallResult | undefined;
    expect(call?.isError).toBe(false);
    expect(call?.content).toHaveLength(2);
    expect(call?.content[0]).toEqual({ type: 'text', text: 'downloaded bill.png token=supe' });
    const image = call?.content[1];
    expect(image?.type).toBe('image');
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data).toBe(FAKE_IMAGE); // full base64 reaches the model
  });

  it('summarizes the image block in the audit (no base64 bytes logged)', async () => {
    await drive([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'fixture_viewfile', arguments: { value: 'bill.png' } },
      },
    ]);
    const lines = (await readFile(auditPath, 'utf8')).trim().split('\n');
    const record = JSON.parse(lines[lines.length - 1] ?? '{}') as AuditRecord;
    const summary = record.result_summary as ContentBlock[];
    expect(Array.isArray(summary)).toBe(true);
    const auditImage = summary.find((b) => b.type === 'image');
    expect(auditImage).toEqual({ type: 'image', mimeType: 'image/png', bytes: FAKE_IMAGE.length });
    expect(auditImage?.data).toBeUndefined(); // base64 never in the audit log
    // text block survives into the audit alongside the summarized image
    expect(summary.find((b) => b.type === 'text')?.text).toContain('downloaded bill.png');
  });
});
