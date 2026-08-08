import { db } from './index';
import * as schema from './schema';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';

const defaultModels = [
  {
    provider: 'Gemini',
    model: 'gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    capabilities: 'Reasoning, Multimodal, Context',
    contextWindow: 2000000,
    reasoningSupport: true,
    enabled: true
  },
  {
    provider: 'OpenAI',
    model: 'gpt-4o',
    displayName: 'GPT-4o',
    capabilities: 'Fast, Reasoning, Multimodal',
    contextWindow: 128000,
    reasoningSupport: true,
    enabled: true
  },
  {
    provider: 'Claude',
    model: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    capabilities: 'Coding, Fast, Reasoning',
    contextWindow: 200000,
    reasoningSupport: true,
    enabled: true
  },
  {
    provider: 'NVIDIA',
    model: 'meta/llama-3.1-70b-instruct',
    displayName: 'Llama 3.1 70B (NIM)',
    capabilities: 'Fast, Open-Weight',
    contextWindow: 128000,
    reasoningSupport: true,
    enabled: true
  },
  {
    provider: 'NVIDIA',
    model: 'meta/llama-3.1-405b-instruct',
    displayName: 'Llama 3.1 405B (NIM)',
    capabilities: 'Heavy Reasoning, Coding',
    contextWindow: 128000,
    reasoningSupport: true,
    enabled: true
  },
  {
    provider: 'NVIDIA',
    model: 'mistralai/mixtral-8x22b-instruct-v0.1',
    displayName: 'Mixtral 8x22B (NIM)',
    capabilities: 'MoE, Fast',
    contextWindow: 65536,
    reasoningSupport: true,
    enabled: true
  }
];

export async function seedDefaultModels() {
  for (const m of defaultModels) {
    const existing = await db.select().from(schema.aiModels).where(eq(schema.aiModels.model, m.model));
    if (existing.length === 0) {
      await db.insert(schema.aiModels).values({
        id: uuidv4(),
        provider: m.provider,
        model: m.model,
        displayName: m.displayName,
        capabilities: m.capabilities,
        contextWindow: m.contextWindow,
        reasoningSupport: m.reasoningSupport,
        enabled: m.enabled,
        priority: 1
      });
      console.log(`Seeded model: ${m.model}`);
    }
  }
}
