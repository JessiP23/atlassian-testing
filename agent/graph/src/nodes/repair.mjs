// Bounded fix loop. Heavy tier, but sees ONLY the failure — never the repo, never the transcript.
//
// The economics that make a repair loop affordable: the model already has the plan and wrote the
// code; what it lacks is the failure. So the prompt is the failure and nothing else. Cody's agent
// re-seeded a fresh session per phase (`splitSessions: true`) for the same reason — a phase that
// carries the whole prior transcript pays for it on every turn.
//
// WHAT CHANGED, and why it mattered more than it looks: this used to be handed
// `logTail: out.slice(-8000)` — the last 8 KB of the gate's stdout. On a lint failure the last 8 KB
// is the footer and the following files' warnings; the one error's file and line are thousands of
// characters earlier and usually truncated away entirely. So the session's first minutes went to
// re-running the gate to find out what had failed, on Opus, inside its own time slice — and with
// 149s of clock (KAN-6) that is the whole budget spent on rediscovery.
//
// lib/gatelog.mjs now parses the output into {file, line, rule, message} deterministically, for
// free, before the model is called. The prompt below leads with those, grouped by file. The raw
// tail still travels underneath for the failure shapes no parser catches.
//
// Bounded at MAX_REPAIR_ATTEMPTS. An agent that cannot make a test pass in three tries is not going
// to on the fourth; it is going to start deleting assertions. Escalate to a human instead.

import { tierFor } from '../lib/models.mjs'
import { runClaude } from '../lib/agent.mjs'
import { formatFailures } from '../lib/gatelog.mjs'
import { MAX_REPAIR_ATTEMPTS } from '../state.mjs'

const PROMPT = (s, { budgetMs, maxMinutes }) => {
  const f = s.gate?.failures || []
  const parsed = formatFailures(f)
  const files = [...new Set(f.map((x) => x.file).filter(Boolean))]
  return `The fix for ${s.issueKey} is in the working tree, but the gate failed. Fix the gate. Do not
re-litigate the ticket and do not re-run a broad search: every failure is listed below with its file
and line.

## What failed
${s.gate.summary}

${parsed ? `## The failures, parsed from the runner's output
${parsed}

Start by opening ${files.slice(0, 3).map((x) => `\`${x}\``).join(', ')} at the lines above. That is where the
problem is; the output tail at the bottom is only for context you cannot get from these.
` : ''}
${s.gate.newFailures?.length ? `## NEW failing tests caused by this patch\n${s.gate.newFailures.slice(0, 20).map((x) => `- ${x}`).join('\n')}\n` : ''}
${s.gate.preExisting?.length ? `## Ignore these — they fail on a clean \`${s.baseBranch}\` too\n${s.gate.preExisting.slice(0, 20).map((x) => `- ${x}`).join('\n')}\n` : ''}
## Output tail
\`\`\`
${(s.gate.logTail || '').slice(-4000)}
\`\`\`

## Rules
- Fix the NEW failures only. The pre-existing ones are not yours and must not be "fixed".
- You may still only edit: ${s.plan.impactedFiles.join(', ')}
${s.repro?.status === 'red' ? `- \`${s.repro.file}\` is the frozen reproducing test. It must end up PASSING and you may not edit it;
  the workflow rejects the run if its hash changes. Run it with: ${s.repro.cmd}` : ''}
- Do NOT weaken or delete an assertion to make a test pass. If the test is right and the code
  cannot satisfy it within these files, write the reason to \`.pag/escalate.txt\` and stop.
- Never introduce a credential, key or token as a literal. The workflow scans the added lines and
  refuses the whole run if it finds one.
- Do not commit and do not switch branches.
- You have ${Math.round(budgetMs / 1000)}s of wall clock. The run has a hard ${maxMinutes}-minute
  deadline and publishing the result takes the rest. Make the smallest change that turns these red.

Attempt ${(s.attempts ?? 0) + 1} of ${MAX_REPAIR_ATTEMPTS}.`
}

export function repairNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const attempts = (s.attempts ?? 0) + 1
    const tier = tierFor('repair')
    const allowance = budget.availableFor('repair')
    if (allowance <= 0.5) {
      return { attempts, refusal: { at: 'repair', reason: 'budget_exhausted', detail: `$${allowance.toFixed(2)} left before the reserve` } }
    }

    // The deadline is authoritative and it is not a refusal any more: graph.mjs routes an
    // out-of-time repair to publish-as-incomplete, so the branch, the diff and the evidence reach
    // a human instead of being deleted at minute 20. This node's job is only to say "not enough
    // clock to try", and 45s is the floor below which an Opus session cannot read a file and edit
    // it. Below that, hand over what we have.
    const timeMs = budget.timeFor('repair')
    if (timeMs < 45_000) {
      onProgress(`repair: ${(budget.timeLeftMs() / 1000).toFixed(0)}s left of ${budget.maxMinutes} min — not enough to try, handing the work over as-is`)
      return { attempts: MAX_REPAIR_ATTEMPTS, outOfTime: true }
    }

    onProgress(`repair attempt ${attempts}/${MAX_REPAIR_ATTEMPTS} — ${(s.gate?.failures || []).length} parsed failure(s), ${(timeMs / 1000).toFixed(0)}s`)
    const { code, cost } = await runClaude({
      cwd: s.repo, prompt: PROMPT(s, { budgetMs: timeMs, maxMinutes: budget.maxMinutes }), model: tier.model, onProgress, timeoutMs: timeMs,
      budgetUsd: Math.min(allowance, allowance / (MAX_REPAIR_ATTEMPTS - attempts + 1)),
    })
    budget.charge('repair', cost, { model: tier.model, attempt: attempts, exit: code })

    return { attempts }
  }
}
