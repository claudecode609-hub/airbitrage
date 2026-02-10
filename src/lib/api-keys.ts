/**
 * API key storage — reads from environment variables or a local config file.
 * In production, these would come from an encrypted database.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), '.airbitrage');
const KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');

export interface ApiKeys {
  anthropicApiKey: string;
  tavilyApiKey: string;
}

export async function getApiKeys(): Promise<ApiKeys> {
  // First check environment variables
  const envKeys: ApiKeys = {
    anthropicApiKey: process.env.AIRBITRAGE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '',
    tavilyApiKey: process.env.TAVILY_API_KEY || '',
  };

  if (envKeys.anthropicApiKey && envKeys.tavilyApiKey) {
    return envKeys;
  }

  // Fall back to local config file
  try {
    const data = await readFile(KEYS_FILE, 'utf-8');
    const stored = JSON.parse(data);
    return {
      anthropicApiKey: envKeys.anthropicApiKey || stored.anthropicApiKey || '',
      tavilyApiKey: envKeys.tavilyApiKey || stored.tavilyApiKey || '',
    };
  } catch {
    return envKeys;
  }
}

export async function saveApiKeys(keys: Partial<ApiKeys>): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch { /* exists */ }

  let existing: Partial<ApiKeys> = {};
  try {
    const data = await readFile(KEYS_FILE, 'utf-8');
    existing = JSON.parse(data);
  } catch { /* doesn't exist */ }

  const merged = { ...existing, ...keys };
  await writeFile(KEYS_FILE, JSON.stringify(merged, null, 2));
}
