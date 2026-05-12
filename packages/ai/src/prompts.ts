import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

export type PromptDef = {
  id: string;
  version: number;
  worker: string;
  model: string;
  temperature: number;
  maxTokens: number;
  body: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_ROOT = join(__dirname, 'prompts');

/**
 * Load a prompt by id from `packages/ai/src/prompts/<id>.md`. Frontmatter is
 * parsed and validated; missing fields throw.
 */
export async function loadPrompt(id: string): Promise<PromptDef> {
  const path = join(PROMPT_ROOT, `${id}.md`);
  const raw = await readFile(path, 'utf8');
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  if (!fm['id'] || typeof fm['id'] !== 'string') throw new Error(`prompt ${id}: missing id`);
  if (typeof fm['version'] !== 'number') throw new Error(`prompt ${id}: missing version`);
  if (!fm['worker']) throw new Error(`prompt ${id}: missing worker`);
  if (!fm['model']) throw new Error(`prompt ${id}: missing model`);
  return {
    id: fm['id'] as string,
    version: fm['version'] as number,
    worker: fm['worker'] as string,
    model: fm['model'] as string,
    temperature: typeof fm['temperature'] === 'number' ? (fm['temperature'] as number) : 0.2,
    maxTokens: typeof fm['max_tokens'] === 'number' ? (fm['max_tokens'] as number) : 2048,
    body: parsed.content,
  };
}

/**
 * Render a prompt template by substituting {{var}} placeholders. Missing
 * variables raise an error to surface bugs early — never silently leave a
 * `{{...}}` token in the rendered output.
 */
export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`prompt template missing variable: ${key}`);
    const v = vars[key];
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
}
