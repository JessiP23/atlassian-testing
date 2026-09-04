// Model tiering. ONE place that decides which model does which job.
//
// Grounded in the bench we already ran (`par bench --sample 20`, real Jira text, identical
// candidates for every model). Numbers are ours, not a vendor leaderboard:
//
//   router alone (no model)                     20.0% hit@5    0s      $0
//   us.anthropic.claude-opus-5                  60.0% hit@5    6.8s    ran 100%
//   us.anthropic.claude-haiku-4-5-...           55.0% hit@5    3.1s    ran 100%   <- winner
//   deepseek.v3.2                               55.0% hit@5    3.5s    ran 100%
//   us.xai.grok-4.6                             50.0% hit@5  167.6s    ran  50%   <- DISQUALIFIED
//
// Two conclusions that drive this file:
//
//   1. Haiku ties Opus on the bounded, well-specified jobs. At n=20 a 5pp gap is ONE ticket.
//      So every phase whose job is "read a bounded input and emit structured output" gets Haiku.
//      That is intake, rerank, plan, package, and the failure classifier.
//
//   2. Grok 4.6 is not a cost option, it is a liability: it answered half the tickets and took
//      54x Haiku's latency. It is deliberately NOT in the tier table. Do not add it back without
//      re-running the bench at --sample 60 and beating `ran 100%`.
//
// Opus is reserved for the two jobs where being wrong is expensive and the input is unbounded:
// writing the patch, and repairing a failing patch from test output.

// Three tiers, and one hard rule that decides which jobs a tier can hold: a tier without TOOL USE
// can only do "read this, emit JSON". It cannot run `claude -p`, cannot iterate a test against a
// runner, cannot drive a browser. GPT-5.6 Luna is exactly that case — $0.44/$1.98 per million
// against Haiku's $1/$5, Converse API supported, no tool use — so it is a candidate for
// intake/rerank/plan/package and for nothing else.
export const TIERS = {
  // Bounded input, structured output, schema-checked. Cheap and fast.
  fast: {
    model: process.env.PAG_MODEL_FAST || 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    priceIn: 1.0,
    priceOut: 5.0,
    maxTokens: 4096,
  },
  // Cheapest tier: bounded JSON only, NO TOOL USE. Opt in per node with PAG_CHEAP_NODES.
  // Must be enabled in your Bedrock account first (Model access -> OpenAI), and it is worth a
  // `par bench --sample 60` before trusting it with the rerank, which is the one that moves hit@5.
  cheap: {
    model: process.env.PAG_MODEL_CHEAP || 'us.openai.gpt-5.6-luna',
    priceIn: 0.44,
    priceOut: 1.98,
    maxTokens: 4096,
    noTools: true,
  },
  // Unbounded reasoning over real code. Expensive; used twice per run at most.
  heavy: {
    model: process.env.PAG_MODEL_HEAVY || 'us.anthropic.claude-opus-5',
    priceIn: 5.0,
    priceOut: 25.0,
    maxTokens: 16384,
  },
}

// Which tier each node runs on. Changing this table is the cost lever — nothing else.
//
// NOTE this is the thing Cody's config could not express: his `PCA_MODEL_TIER=low` only lowered
// `--effort` and left mainModel as Opus 5 for EVERY phase (lib-agent-core.sh:139 blanks PLAN_MODEL).
// That is why ESI2-3376 spent $1.05 + $1.54 on triage+propose — two phases that are pure
// summarisation — and then starved apply at $4.54 of a $7.00 pre-finalize budget.
export const NODE_TIER = {
  intake: 'fast',   // ticket -> spec. Summarisation.
  rerank: 'fast',   // 25 router candidates -> top 5. Bounded, measured at 55%.
  plan: 'fast',     // spec + 5 files -> impactedFiles + steps. Bounded.
  repro: 'heavy',   // writes the reproducing test and proves it red. Needs tools (runs jest).
  patch: 'heavy',   // writes the code. The one job worth Opus.
  repair: 'heavy',  // reads failing test output, fixes. Unbounded.
  classify: 'fast', // "is this failure mine or baseline?" — a yes/no over a log tail.
  package: 'fast',  // PR title/body/test notes. Summarisation.
}

// Nodes that may run on the cheap tier, from the environment:
//   PAG_CHEAP_NODES=intake,rerank,plan,package
// A node that needs tools (patch, repair, repro) is refused here rather than failing mid-run with
// an unhelpful error from the model.
const TOOL_NODES = new Set(['patch', 'repair', 'repro'])
const CHEAP = new Set((process.env.PAG_CHEAP_NODES || '').split(',').map((x) => x.trim()).filter(Boolean))
for (const n of CHEAP) {
  if (TOOL_NODES.has(n)) throw new Error(`PAG_CHEAP_NODES includes "${n}", which needs tool use — the cheap tier (${TIERS.cheap.model}) has none. Remove it.`)
}

export function tierFor(node) {
  const name = CHEAP.has(node) ? 'cheap' : NODE_TIER[node]
  if (!name) throw new Error(`no tier configured for node "${node}" — add it to NODE_TIER`)
  return { name, ...TIERS[name] }
}

// Estimated USD for a call. Used for the per-run budget guard, never for billing:
// AWS Budgets on actual billed spend is the authoritative cap.
export function estimateCost(tier, inTok, outTok) {
  return (inTok / 1e6) * tier.priceIn + (outTok / 1e6) * tier.priceOut
}
