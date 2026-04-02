import { readFile } from 'fs/promises';

import nunjucks from 'nunjucks';

const DOC_TAG_PATTERN = /\{\{doc:(\/[^}]+)\}\}/g;

async function replaceDocTag(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return `[doc not found: ${filePath}]`;
  }
}

async function preprocessDocTags(template: string): Promise<string> {
  const matches = [...template.matchAll(DOC_TAG_PATTERN)];
  if (matches.length === 0) {
    return template;
  }

  const replacements = await Promise.all(matches.map((match) => replaceDocTag(match[1]!)));

  let result = template;
  for (let index = 0; index < matches.length; index++) {
    result = result.replace(matches[index]![0], replacements[index]!);
  }

  return result;
}

const nunjucksEnvironment = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});

export async function renderTemplate(template: string, payload: unknown): Promise<string> {
  const preprocessed = await preprocessDocTags(template);

  const spreadable = typeof payload === 'object' && payload !== null ? payload : {};
  const context = {
    payload: JSON.stringify(payload, null, 2),
    ...spreadable,
  };

  return nunjucksEnvironment.renderString(preprocessed, context);
}
