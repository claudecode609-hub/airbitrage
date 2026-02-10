import { NextResponse } from 'next/server';
import { getApiKeys } from '@/lib/api-keys';

export async function GET() {
  const keys = await getApiKeys();

  return NextResponse.json({
    hasAnthropicKey: !!keys.anthropicApiKey,
    anthropicKeyPrefix: keys.anthropicApiKey?.slice(0, 15) || 'MISSING',
    hasTavilyKey: !!keys.tavilyApiKey,
    tavilyKeyPrefix: keys.tavilyApiKey?.slice(0, 15) || 'MISSING',
  });
}
