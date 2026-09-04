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

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' })

const noTemperature = new Set(['us.anthropic.claude-opus-5', 'us.xai.grok-4.6'])
const isReasoning = (id) => /gpt-oss|qwen3|deepseek[.-]r|grok|\bo[134]\b|reasoning|thinking/i.test(id)

export const usage = { inputTokens: 0, outputTokens: 0, calls: 0, throttled: 0 }
export const resetUsage = () => Object.assign(usage, { inputTokens: 0, outputTokens: 0, calls: 0, throttled: 0 })

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

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await client.send(new ConverseCommand(req))
      const text = (res.output?.message?.content || []).map((c) => c.text || '').join('').trim()
      const inTok = res.usage?.inputTokens ?? 0
      const outTok = res.usage?.outputTokens ?? 0
      usage.inputTokens += inTok; usage.outputTokens += outTok; usage.calls++
      if (!text && attempt < 3) { req.inferenceConfig.maxTokens = budget * 2; continue }
      return { text, inTok, outTok }
    } catch (err) {
      const name = err?.name || ''
      if (/Throttling|TooManyRequests|ServiceUnavailable/i.test(name) && attempt < 3) {
        usage.throttled++
        await new Promise((r) => setTimeout(r, Math.random() * (500 * 2 ** attempt)))
        continue
      }
      throw err
    }
  }
  throw new Error(`converse: ${model} returned nothing after 4 attempts`)
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
