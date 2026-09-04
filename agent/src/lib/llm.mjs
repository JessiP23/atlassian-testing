// Pluggable LLM provider. One function, four backends, no SDK for three of them.
//
// The point of the abstraction is that the provider is a COST and GOVERNANCE decision,
// not an architectural one. Swap it with an env var and re-run the eval; if a free Groq
// model scores the same as Opus on re-ranking, use the free one. Measure, don't assume.
//
//   LLM_PROVIDER=groq       LLM_MODEL=llama-3.3-70b-versatile   GROQ_API_KEY=...
//   LLM_PROVIDER=openai     LLM_MODEL=gpt-4o-mini               OPENAI_API_KEY=...
//   LLM_PROVIDER=anthropic  LLM_MODEL=claude-haiku-4-5-20251001 ANTHROPIC_API_KEY=...
//   LLM_PROVIDER=bedrock    LLM_MODEL=us.anthropic.claude-...   (uses the AWS SDK if installed)
//   LLM_PROVIDER=none       disables all LLM steps (default)
//
// GOVERNANCE NOTE: expansion and re-rank send file paths and exported symbol names -
// proprietary structure, not source. Bedrock keeps that inside your own AWS account.
// A public free tier does not, and typically offers no DPA and no SLA. Fine for
// measuring on a throwaway sample; a decision to make deliberately before production.

const TIMEOUT_MS = 30_000

/** Aggregate token usage for the process, so cost per ticket is measurable not guessed. */
export const usage = {
  calls: 0, inputTokens: 0, outputTokens: 0, errors: 0, rateLimited: 0, lastLatencyMs: 0,
}

/** Reset between models so a benchmark measures each one independently. */
export function resetUsage() {
  usage.calls = 0
  usage.inputTokens = 0
  usage.outputTokens = 0
  usage.errors = 0
  usage.rateLimited = 0
  usage.lastLatencyMs = 0
}

export function provider() {
  return (process.env.LLM_PROVIDER || 'none').toLowerCase()
}

export function isEnabled() {
  return provider() !== 'none'
}

function model(dflt) {
  return process.env.LLM_MODEL || dflt
}

async function withTimeout(fn) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    return await fn(ac.signal)
  } finally {
    clearTimeout(t)
  }
}

/**
 * Reasoning models spend output budget thinking before they emit anything, so a budget
 * sized for the answer alone returns EMPTY - the call succeeds, bills for tokens, and
 * yields no text. Observed on gpt-oss (Groq) and grok-4.6 (Bedrock): 42 input / 16 output
 * tokens consumed, 11 seconds, empty string.
 *
 * Matching by name is a heuristic and will miss the next family. The symptom to look for
 * is exactly the one above: non-zero token usage with no text.
 */
function isReasoningModel(id) {
  // deepseek[.-]r matches both `deepseek-r1` and Bedrock's `deepseek.r1-v1:0`.
  return /gpt-oss|qwen3|deepseek[.-]r|grok|\bo[134]\b|reasoning|thinking/i.test(id)
}

/**
 * OpenAI-compatible chat completions - covers Groq, OpenAI, OpenRouter, vLLM, Ollama.
 *
 * Two accommodations for reasoning models, both learned the hard way:
 *
 *  - They consume max_tokens on internal reasoning before producing a single output
 *    token, so a budget sized for the answer alone returns EMPTY. Groq then rejects it as
 *    `json_validate_failed` with an empty `failed_generation`, which reads like a prompt
 *    problem and is actually a budget problem. We raise the ceiling and ask for low
 *    reasoning effort, since these are extraction tasks, not proofs.
 *
 *  - Strict `response_format` turns a partial generation into a hard 400 rather than a
 *    salvageable string. Since parseJson() is already tolerant of fences and prose, we
 *    retry once without the constraint instead of losing the call.
 */
async function openaiCompatible({ baseUrl, apiKey, dfltModel, system, user, maxTokens, json }) {
  const modelId = model(dfltModel)
  const reasoning = isReasoningModel(modelId)
  const budget = reasoning ? Math.max(maxTokens * 4, 3000) : maxTokens

  const send = (useJsonFormat) =>
    withTimeout(async (signal) => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: budget,
          temperature: 0,
          ...(reasoning ? { reasoning_effort: 'low' } : {}),
          ...(useJsonFormat ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })
      const body = await res.text()
      if (res.status === 429) {
        const err = new Error(`429 rate limited`)
        err.status = 429
        err.retryAfter = Number(res.headers.get('retry-after') || 0)
        err.body = body
        throw err
      }
      if (!res.ok) {
        const err = new Error(`${res.status} ${body.slice(0, 300)}`)
        err.status = res.status
        err.body = body
        throw err
      }
      const j = JSON.parse(body)
      usage.inputTokens += j.usage?.prompt_tokens || 0
      usage.outputTokens += j.usage?.completion_tokens || 0
      return j.choices?.[0]?.message?.content ?? ''
    })

  // Rate limits are the normal case on a free tier, not an exception - a batch eval will
  // hit them within a few calls. Honour Retry-After when the server sends it, otherwise
  // back off exponentially. Without this, an eval over 40 tickets reports near-total
  // failure and looks like a broken integration.
  const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 4)
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(json)
    } catch (err) {
      if (json && /json_validate_failed|response_format/i.test(err.body || '')) {
        if (process.env.LLM_DEBUG) console.error('  [llm] strict JSON rejected, retrying unconstrained')
        json = false
        continue
      }
      const retryable = err.status === 429 || (err.status >= 500 && err.status < 600)
      if (!retryable || attempt >= MAX_RETRIES) throw err
      const waitMs = err.retryAfter
        ? Math.ceil(err.retryAfter * 1000)
        : Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500
      usage.rateLimited++
      if (process.env.LLM_DEBUG) {
        console.error(`  [llm] ${err.status}, waiting ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
      }
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

async function anthropicDirect({ system, user, maxTokens }) {
  return withTimeout(async (signal) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model('claude-haiku-4-5-20251001'),
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
    const j = await res.json()
    usage.inputTokens += j.usage?.input_tokens || 0
    usage.outputTokens += j.usage?.output_tokens || 0
    return j.content?.map((c) => c.text || '').join('') ?? ''
  })
}

/**
 * Bedrock via the CONVERSE API - deliberately not InvokeModel.
 *
 * InvokeModel requires each provider's native request shape: Anthropic wants
 * `anthropic_version` + typed content blocks, DeepSeek wants something else, Llama
 * something else again. Converse normalises all of them behind one schema, so switching
 * LLM_MODEL from an Anthropic id to a DeepSeek id needs no code change at all - which is
 * the entire point when the goal is comparing models on cost.
 *
 * Needs SigV4, so this is the one provider that uses an SDK.
 */
/**
 * Models that reject `temperature`, learned at runtime.
 *
 * Newer models (Opus 5, Grok 4.6) control sampling internally and return a hard error if
 * `temperature` is sent at all, while Haiku and DeepSeek still accept it. Rather than
 * maintaining a hand-written compatibility list that rots every time a model ships, send
 * it once, catch the specific complaint, remember it, and retry without. Determinism is
 * preserved on the models that support it.
 */
const _noTemperature = new Set()

let _bedrockClient = null
async function bedrock({ system, user, maxTokens }) {
  let mod
  try {
    mod = await import('@aws-sdk/client-bedrock-runtime')
  } catch {
    throw new Error('LLM_PROVIDER=bedrock requires: npm i @aws-sdk/client-bedrock-runtime')
  }
  const { BedrockRuntimeClient, ConverseCommand } = mod
  const region = process.env.AWS_REGION || 'us-east-1'
  if (!_bedrockClient) _bedrockClient = new BedrockRuntimeClient({ region })

  const modelId = model('us.anthropic.claude-opus-5')
  const reasoning = isReasoningModel(modelId)

  const send = async (withTemperature) => {
    const t0 = Date.now()
    const out = await _bedrockClient.send(
      new ConverseCommand({
        modelId,
        // Converse takes `system` as its own array, not inside messages.
        ...(system ? { system: [{ text: system }] } : {}),
        messages: [{ role: 'user', content: [{ text: user }] }],
        inferenceConfig: {
          maxTokens: reasoning ? Math.max(maxTokens * 4, 3000) : maxTokens,
          ...(withTemperature ? { temperature: 0 } : {}),
        },
      })
    )
    usage.lastLatencyMs = Date.now() - t0
    usage.inputTokens += out.usage?.inputTokens || 0
    usage.outputTokens += out.usage?.outputTokens || 0
    // Reasoning models return reasoningContent blocks alongside text - keep only text.
    return (out.output?.message?.content || []).map((c) => c.text || '').join('')
  }

  if (_noTemperature.has(modelId)) return send(false)

  try {
    return await send(true)
  } catch (err) {
    if (/temperature/i.test(err?.message || '')) {
      _noTemperature.add(modelId)
      if (process.env.LLM_DEBUG) {
        console.error(`  [llm] ${modelId} rejects temperature - retrying without, and remembering`)
      }
      return await send(false)
    }
    throw err
  }
}

/**
 * @param {object} o
 * @param {string} o.system
 * @param {string} o.user
 * @param {number} [o.maxTokens]
 * @param {boolean} [o.json] request JSON-object output where the provider supports it
 * @returns {Promise<string|null>} null when disabled or on a handled failure
 */
export async function complete({ system, user, maxTokens = 700, json = false }) {
  const p = provider()
  if (p === 'none') return null
  usage.calls++
  try {
    switch (p) {
      case 'groq':
        return await openaiCompatible({
          baseUrl: process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
          apiKey: process.env.GROQ_API_KEY,
          dfltModel: 'llama-3.3-70b-versatile',
          system, user, maxTokens, json,
        })
      case 'openai':
        return await openaiCompatible({
          baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
          apiKey: process.env.OPENAI_API_KEY,
          dfltModel: 'gpt-4o-mini',
          system, user, maxTokens, json,
        })
      case 'anthropic':
        return await anthropicDirect({ system, user, maxTokens })
      case 'bedrock':
        return await bedrock({ system, user, maxTokens })
      default:
        throw new Error(`unknown LLM_PROVIDER: ${p}`)
    }
  } catch (err) {
    usage.errors++
    // Never let an LLM failure fail the pipeline - the deterministic result stands alone.
    // That property is what makes the LLM layer optional rather than load-bearing.
    if (process.env.LLM_DEBUG) console.error(`  [llm] ${err.message}`)
    return null
  }
}

/** Tolerant JSON extraction - small models like to wrap JSON in prose or fences. */
export function parseJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Rough USD estimate. Rates are per 1M tokens; override with LLM_PRICE_IN / LLM_PRICE_OUT. */
export function estimateCost() {
  const inRate = Number(process.env.LLM_PRICE_IN || 1.0)
  const outRate = Number(process.env.LLM_PRICE_OUT || 5.0)
  return (usage.inputTokens / 1e6) * inRate + (usage.outputTokens / 1e6) * outRate
}
