import { z } from 'zod';

/** Trusted user commands, not a fixture DSL or a read-only command classifier. */
export const attemptSchema = z.object({
  before: z.array(z.string().min(1).max(16384)).max(20),
  after: z.array(z.string().min(1).max(16384)).max(20),
  workdir: z.string().min(1).optional(),
  credentials: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(20).optional(),
  timeout_seconds: z.number().int().min(1).max(900).optional(),
  cleanup_timeout_seconds: z.number().int().min(1).max(120).optional(),
  writes: z.boolean(),
}).strict();

// Conservative provider namespaces; workloads still receive only explicitly selected references.
export const providerCredentialName = name => /^(?:(?:ANTHROPIC|OPENAI|GOOGLE|GCLOUD|GEMINI|GROQ|MISTRAL|OPENROUTER|TOGETHER|XAI|AWS|AZURE|COHERE|CEREBRAS|DEEPSEEK|HF|HUGGING_FACE|COPILOT|ANT_LING|QWEN|NVIDIA|TYPESAFE|RADIUS|AI_GATEWAY|ZAI|MINIMAX|MOONSHOT|FIREWORKS|BASETEN|OPENCODE|KIMI|META|CLOUDFLARE|XIAOMI)_)/i.test(name);
export const HOOK_RECORDING_REASON = 'attempt hooks require agent execution; capture/replay cannot skip the declared lifecycle';
