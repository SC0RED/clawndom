import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'fs/promises';
import { renderTemplate } from '../../../src/lib/template/template-engine';

describe('renderTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render {{ payload }} as full JSON string', async () => {
    const payload = { issue: { key: 'SPE-123' } };
    const result = await renderTemplate('{{ payload }}', payload);
    expect(result).toBe(JSON.stringify(payload, null, 2));
  });

  it('should resolve top-level payload keys via Nunjucks', async () => {
    const payload = { issue: { key: 'SPE-456' } };
    const result = await renderTemplate('{{ issue.key }}', payload);
    expect(result).toBe('SPE-456');
  });

  it('should inline file contents for {{doc:/path}} tags', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('# Instructions\nDo the thing.');

    const result = await renderTemplate('{{doc:/tmp/instructions.md}}', { foo: 'bar' });

    expect(readFile).toHaveBeenCalledWith('/tmp/instructions.md', 'utf-8');
    expect(result).toBe('# Instructions\nDo the thing.');
  });

  it('should replace missing doc file with not-found placeholder', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await renderTemplate('{{doc:/missing/file.md}}', {});

    expect(result).toBe('[doc not found: /missing/file.md]');
  });

  it('should render missing field as empty string', async () => {
    const result = await renderTemplate('value={{ nonexistent }}', { foo: 'bar' });
    expect(result).toBe('value=');
  });

  it('should handle both doc tags and Nunjucks variables in the same template', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('file content here');

    const result = await renderTemplate('Key: {{ issue.key }}\nDoc: {{doc:/tmp/doc.md}}', {
      issue: { key: 'SPE-789' },
    });

    expect(result).toBe('Key: SPE-789\nDoc: file content here');
  });

  it('should handle multiple doc tags', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('first file').mockResolvedValueOnce('second file');

    const result = await renderTemplate('{{doc:/tmp/a.md}} and {{doc:/tmp/b.md}}', {});

    expect(result).toBe('first file and second file');
  });
});
