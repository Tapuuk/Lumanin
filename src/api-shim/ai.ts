import type { AI as SpecAI } from '@raycast/api'
import { markUnavailable } from './unsupported'

/**
 * `AI` — present, and off.
 *
 * RAYCAST-COMPAT.md §Wave 3: no AI provider ships with Lumanin, and there is no
 * hosted service behind us to call. The namespace exists so that importing it is
 * not a crash and so `environment.canAccess(AI)` can answer **false** — which is
 * the whole point of that API: extensions call it to choose a fallback, and an
 * optimistic `true` removes the fallback and leaves them failing later, further
 * from the cause.
 *
 * `ask` throws a plain `Error`, not `PlatformNotSupportedError`: "you have not
 * configured a provider" is not a statement about Linux, and the store scanner
 * must not read it as one.
 *
 * `Model` is **generated from the spec** (126 members) — the values are
 * upstream identifiers with no pattern to them, so hand-copying is pure risk.
 */
const Model = {
  'OpenAI_GPT-5_mini': 'openai-gpt-5-mini',
  'OpenAI_GPT-5_nano': 'openai-gpt-5-nano',
  'OpenAI_GPT-4.1': 'openai-gpt-4.1',
  'OpenAI_GPT-4.1_mini': 'openai-gpt-4.1-mini',
  'OpenAI_GPT-4.1_nano': 'openai-gpt-4.1-nano',
  'OpenAI_GPT-4': 'openai-gpt-4',
  'OpenAI_GPT-4_Turbo': 'openai-gpt-4-turbo',
  'OpenAI_GPT-4o': 'openai-gpt-4o',
  'OpenAI_GPT-4o_mini': 'openai-gpt-4o-mini',
  'OpenAI_GPT-5': 'openai_o1-gpt-5',
  'OpenAI_GPT-5.1': 'openai-gpt-5.1',
  'OpenAI_GPT-5.1_Codex': 'openai-gpt-5.1-codex',
  'OpenAI_GPT-5.1_Instant': 'openai-gpt-5.1-instant',
  'OpenAI_GPT-5.2': 'openai-gpt-5.2',
  'OpenAI_GPT-5.2_Instant': 'openai-gpt-5.2-instant',
  'OpenAI_GPT-5.3_Instant': 'openai-gpt-5.3-instant',
  'OpenAI_GPT-5.3_Codex': 'openai-gpt-5.3-codex',
  'OpenAI_GPT-5.4': 'openai-gpt-5.4',
  'OpenAI_GPT-5.4_mini': 'openai-gpt-5.4-mini',
  'OpenAI_GPT-5.4_nano': 'openai-gpt-5.4-nano',
  OpenAI_o3: 'openai_o1-o3',
  'OpenAI_o4-mini': 'openai_o1-o4-mini',
  OpenAI_o1: 'openai_o1-o1',
  'OpenAI_o3-mini': 'openai_o1-o3-mini',
  'Groq_GPT-OSS_20b': 'groq-openai/gpt-oss-20b',
  'Groq_GPT-OSS_120b': 'groq-openai/gpt-oss-120b',
  'Anthropic_Claude_4.5_Haiku': 'anthropic-claude-4-5-haiku',
  Anthropic_Claude_4_Sonnet: 'anthropic-claude-sonnet-4',
  'Anthropic_Claude_4.5_Sonnet': 'anthropic-claude-sonnet-4-5',
  'Anthropic_Claude_4.6_Sonnet': 'anthropic-claude-sonnet-4-6',
  'Anthropic_Claude_4.5_Opus': 'anthropic-claude-opus-4-5',
  'Anthropic_Claude_4.6_Opus': 'anthropic-claude-opus-4-6',
  'Anthropic_Claude_4.7_Opus': 'anthropic-claude-opus-4-7',
  Perplexity_Sonar: 'perplexity-sonar',
  Perplexity_Sonar_Pro: 'perplexity-sonar-pro',
  Groq_Llama_4_Scout: 'groq-meta-llama/llama-4-scout-17b-16e-instruct',
  'Groq_Llama_3.3_70B': 'groq-llama-3.3-70b-versatile',
  'Groq_Llama_3.1_8B': 'groq-llama-3.1-8b-instant',
  Mistral_Nemo: 'mistral-open-mistral-nemo',
  Mistral_Large: 'mistral-mistral-large-latest',
  Mistral_Medium: 'mistral-mistral-medium-latest',
  Mistral_Small_3: 'mistral-mistral-small-latest',
  Mistral_Codestral: 'mistral-codestral-latest',
  'Groq_Qwen3-32B': 'groq-qwen/qwen3-32b',
  'Google_Gemini_3.1_Flash_Lite': 'google-gemini-3.1-flash-lite',
  Google_Gemini_3_Flash: 'google-gemini-3-flash',
  'Google_Gemini_3.1_Pro': 'google-gemini-3.1-pro',
  'Google_Gemini_2.5_Pro': 'google-gemini-2.5-pro',
  'Google_Gemini_2.5_Flash': 'google-gemini-2.5-flash',
  'Google_Gemini_2.5_Flash_Lite': 'google-gemini-2.5-flash-lite',
  'Together_AI_Qwen3-235B-A22B-Instruct-2507-tput': 'together-Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
  'Together_AI_DeepSeek-R1': 'together-deepseek-ai/DeepSeek-R1',
  'Together_AI_DeepSeek-V3': 'together-deepseek-ai/DeepSeek-V3',
  'Together_AI_Kimi_K2.5': 'together-moonshotai/Kimi-K2.5',
  'xAI_Grok-4.1_Fast': 'xai-grok-4-1-fast',
  'xAI_Grok-4.20': 'xai-grok-4.20',
  'xAI_Grok-4': 'xai-grok-4',
  'xAI_Grok-4_Fast': 'xai-grok-4-fast',
  xAI_Grok_Code_Fast_1: 'xai-grok-code-fast',
  'xAI_Grok-3_Beta': 'xai-grok-3',
  'xAI_Grok-3_Mini_Beta': 'xai-grok-3-mini',
  Google_Gemini_3_Pro: 'google-gemini-3.1-pro',
  'OpenAI_GPT-5_Codex': 'openai-gpt-5-codex',
  'Anthropic_Claude_3.5_Haiku': 'anthropic-claude-4-5-haiku',
  'Anthropic_Claude_3.7_Sonnet': 'anthropic-claude-sonnet-4-5',
  Anthropic_Claude_4_Opus: 'anthropic-claude-opus-4',
  'Anthropic_Claude_4.1_Opus': 'anthropic-claude-opus-4-1',
  'Together_AI_Llama_3.1_405B': 'together-meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
  'Google_Gemini_2.0_Flash': 'google-gemini-2.0-flash',
  'Google_Gemini_2.0_Flash_Lite': 'google-gemini-2.0-flash-lite',
  'xAI_Grok-2': 'xai-grok-2-latest',
  'OpenAI_GPT3.5-turbo-instruct': 'openai-gpt-4o-mini',
  Anthropic_Claude_Opus: 'anthropic-claude-opus-4-1',
  'Google_Gemini_2.0_Flash_Thinking': 'google-gemini-2.5-flash',
  Llama2_70B: 'groq-llama-3.3-70b-versatile',
  Perplexity_Sonar_Medium_Online: 'perplexity-sonar',
  Perplexity_Sonar_Small_Online: 'perplexity-sonar',
  Codellama_70B_instruct: 'groq-llama-3.3-70b-versatile',
  Perplexity_Llama3_Sonar_Large: 'perplexity-sonar',
  Perplexity_Llama3_Sonar_Small: 'perplexity-sonar',
  'OpenAI_GPT3.5-turbo': 'openai-gpt-4o-mini',
  'Llama3.1_70B': 'groq-llama-3.3-70b-versatile',
  'Perplexity_Llama3.1_Sonar_Huge': 'perplexity-sonar-pro',
  'Perplexity_Llama3.1_Sonar_Large': 'perplexity-sonar',
  'Perplexity_Llama3.1_Sonar_Small': 'perplexity-sonar',
  Mistral_Large2: 'mistral-mistral-large-latest',
  'Groq_DeepSeek_R1_Distill_Llama_3.3_70B': 'together-deepseek-ai/DeepSeek-R1',
  Together_DeepSeek_R1: 'together-deepseek-ai/DeepSeek-R1',
  MixtraL_8x7B: 'mistral-open-mistral-nemo',
  'Google_Gemini_1.5_Flash': 'google-gemini-2.5-flash',
  'Google_Gemini_1.5_Pro': 'google-gemini-2.5-flash',
  Mixtral_8x7B: 'mistral-open-mistral-nemo',
  'Qwen_2.5_32B': 'openai-gpt-4o-mini',
  'OpenAI_o1-preview': 'openai_o1-o1',
  'OpenAI_o1-mini': 'openai_o1-o4-mini',
  Llama3_70B: 'groq-llama-3.3-70b-versatile',
  'Anthropic_Claude_Sonnet_3.7': 'anthropic-claude-sonnet-4-5',
  Anthropic_Claude_Sonnet: 'anthropic-claude-sonnet-4-5',
  Perplexity_Sonar_Reasoning: 'perplexity-sonar-pro',
  OpenAI_GPT_OSS_20b: 'groq-openai/gpt-oss-20b',
  OpenAI_GPT_OSS_120b: 'groq-openai/gpt-oss-120b',
  OpenAI_GPT5: 'openai_o1-gpt-5',
  'OpenAI_GPT5-mini': 'openai-gpt-5-mini',
  'OpenAI_GPT5-nano': 'openai-gpt-5-nano',
  OpenAI_GPT4: 'openai-gpt-4',
  'OpenAI_GPT4-turbo': 'openai-gpt-4-turbo',
  'OpenAI_GPT4.1': 'openai-gpt-4.1',
  'OpenAI_GPT4.1-nano': 'openai-gpt-4.1-nano',
  'OpenAI_GPT4.1-mini': 'openai-gpt-4.1-mini',
  OpenAI_GPT4o: 'openai-gpt-4o',
  'OpenAI_GPT4o-mini': 'openai-gpt-4o-mini',
  Anthropic_Claude_Haiku: 'anthropic-claude-4-5-haiku',
  Mistral_Small: 'mistral-mistral-small-latest',
  'Llama3.3_70B': 'groq-llama-3.3-70b-versatile',
  'Llama3.1_8B': 'groq-llama-3.1-8b-instant',
  'Llama3.1_405B': 'together-meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
  Llama4_Scout: 'groq-meta-llama/llama-4-scout-17b-16e-instruct',
  DeepSeek_R1: 'together-deepseek-ai/DeepSeek-R1',
  DeepSeek_V3: 'together-deepseek-ai/DeepSeek-V3',
  xAI_Grok_2: 'xai-grok-4',
  xAI_Grok_3: 'xai-grok-3',
  xAI_Grok_4: 'xai-grok-4',
  xAI_Grok_3_Mini: 'xai-grok-3-mini',
  Groq_Qwen3_32B: 'groq-qwen/qwen3-32b',
  Groq_Qwen3_235B_A22B_Instruct_2507_tput: 'together-Qwen/Qwen3-235B-A22B-Instruct-2507-tput',
  Groq_Kimi_K2_Instruct: 'together-moonshotai/Kimi-K2.5'
} as const

function ask(): never {
  throw new Error(
    'AI.ask() needs an AI provider, and none is configured. Lumanin ships no AI service and no provider setting exists.'
  )
}

export const AI = markUnavailable({
  ask: ask as unknown as typeof SpecAI.ask,
  Model
})
