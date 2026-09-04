// The single Bedrock call path. Converse API, so swapping model families never changes caller code.
//
// Why still Bedrock (the question was asked, so the answer is recorded here):
//   * the model traffic stays inside the company's own AWS account — the reason it was chosen
//     over a direct API key, and the reason it survives a security review;
//   * AWS Budgets with an auto-attaching deny policy is a HARD cap on spend. No SaaS dashboard
//     limit is equivalent — it stops the calls, it doesn't just email you;
//   * one IAM identity for every model, so cost is attributable per agent user;
//   * Converse normalises Anthropic / DeepSeek / xAI behind one request shape.
// The cost of that choice is real: some ids need the `us.` inference-profile prefix and some reject
// it, and prompt-cache behaviour differs from the direct API. Both are handled below.
//
// Learned quirks, kept because each one cost a debugging cycle:
//   * `us.anthropic.claude-opus-5` and `us.xai.grok-4.6` REJECT `temperature`. Learned per-id.
//   * reasoning-family models spend the output budget on hidden reasoning and return empty text
//     unless the budget is inflated.
//   * `deepseek.v3.2` is a BARE id — `us.deepseek.v3.2` is invalid.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'

// maxAttempts is the SDK's own retry, which uses milliseconds of backoff — useful for a blip,
// useless for capacity. The loop below owns the real waiting.
const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  maxAttempts: 3,
})

const noTemperature = new Set(['us.anthropic.claude-opus-5', 'us.xai.grok-4.6'])
const isReasoning = (id) => /gpt-oss|qwen3|deepseek[.-]r|grok|\bo[134]\b|reasoning|thinking/i.test(id)

export const usage = { inputTokens: 0, outputTokens: 0, calls: 0, throttled: 0 }
export const resetUsage = () => Object.assign(usage, { inputTokens: 0, outputTokens: 0, calls: 0, throttled: 0 })

// CAPACITY IS NOT AN ERROR, IT IS A WAIT.
//
// A run died at intake with `ServiceUnavailableException` (503) after the SDK's three attempts and
// 106 MILLISECONDS of total backoff. 503 from Bedrock means the region has no capacity for that
// model right now; the answer is to wait seconds, not milliseconds, and then to try the same model
// through a different inference profile before giving up.
//
// Cross-region profiles exist exactly for this: `us.<id>` is served from US regions, `global.<id>`
// from wherever there is room, and the bare id is in-region only. When one is saturated another
// usually is not, so a 503 walks the list. Whichever id answers is remembered for the process, so
// one run does not pay the discovery twice.
const RETRYABLE = /Throttling|TooManyRequests|ServiceUnavailable|ModelNotReady|InternalServer|Timeout/i
const ATTEMPTS = Number(process.env.PAG_BEDROCK_ATTEMPTS || 6)
const resolved = new Map()

/** us.foo -> [us.foo, global.foo, foo] · global.foo -> [global.foo, us.foo, foo] · foo -> [foo] */
function profileChain(model) {
  const bare = String(model).replace(/^(us|eu|apac|global)\./, '')
  const chain = [model]
  for (const alt of [`global.${bare}`, `us.${bare}`, bare]) if (!chain.includes(alt)) chain.push(alt)
  return chain
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const backoff = (attempt) => Math.min(30_000, 1_500 * 2 ** attempt) * (0.5 + Math.random() / 2)

/**
 * @param {{model:string, system:string, user:string, maxTokens?:number, json?:boolean}} args
 * @returns {Promise<{text:string, inTok:number, outTok:number}>}
 */
export async function converse({ model, system, user, maxTokens = 4096, json = false }) {
  const budget = isReasoning(model) ? Math.max(maxTokens * 4, 3000) : maxTokens
  const inferenceConfig = { maxTokens: budget }
  if (!noTemperature.has(model)) inferenceConfig.temperature = 0

  const req = {
    modelId: model,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig,
  }

  const chain = resolved.has(model) ? [resolved.get(model)] : profileChain(model)
  let last = null

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // Walk the profiles as attempts accumulate: same id twice, then the next profile.
    req.modelId = chain[Math.min(Math.floor(attempt / 2), chain.length - 1)]
    try {
      const res = await client.send(new ConverseCommand(req))
      const text = (res.output?.message?.content || []).map((c) => c.text || '').join('').trim()
      const inTok = res.usage?.inputTokens ?? 0
      const outTok = res.usage?.outputTokens ?? 0
      usage.inputTokens += inTok; usage.outputTokens += outTok; usage.calls++
      resolved.set(model, req.modelId)
      // Empty text means the output budget went on hidden reasoning: inflate and retry, same id.
      if (!text && attempt < ATTEMPTS - 1) { req.inferenceConfig.maxTokens = budget * 2; continue }
      return { text, inTok, outTok }
    } catch (err) {
      last = err
      const name = err?.name || ''
      const retryable = RETRYABLE.test(name) || err?.$metadata?.httpStatusCode >= 500
      if (!retryable || attempt === ATTEMPTS - 1) break
      usage.throttled++
      const wait = backoff(attempt)
      const next = chain[Math.min(Math.floor((attempt + 1) / 2), chain.length - 1)]
      console.error(`      bedrock ${name} on ${req.modelId} — retrying in ${(wait / 1000).toFixed(1)}s${next !== req.modelId ? ` as ${next}` : ''}`)
      await sleep(wait)
    }
  }
  const tried = [...new Set(chain.slice(0, Math.min(Math.ceil(ATTEMPTS / 2), chain.length)))].join(', ')
  throw new Error(
    `Bedrock could not serve ${model} after ${ATTEMPTS} attempts across ${tried}: ${last?.name || 'unknown'}. ` +
    'A 503 here is regional capacity, not a bad request — re-run, or set PAG_MODEL_FAST / PAG_MODEL_HEAVY ' +
    'to a profile with room (global.<id> is usually the answer).'
  )
}

/** Converse + strict JSON parse. Retries ONCE unconstrained, then gives up honestly. */
export async function converseJson({ model, system, user, maxTokens }) {
  const sys = `${system}\n\nRespond with ONLY a single JSON object. No prose, no markdown fence.`
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, inTok, outTok } = await converse({ model, system: sys, user, maxTokens })
    const body = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    try {
      return { data: JSON.parse(body), inTok, outTok }
    } catch {
      if (attempt === 1) throw new Error(`converseJson: ${model} did not return JSON: ${body.slice(0, 300)}`)
    }
  }
}
