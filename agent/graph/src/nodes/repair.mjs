// Bounded fix loop. Heavy tier, but sees ONLY the failing output — never the repo.
//
// The economics that make a repair loop affordable: the model already has the plan and wrote the
// code; what it lacks is the failure. So the prompt is the failure and nothing else. Cody's agent
// re-seeded a fresh session per phase (`splitSessions: true`) for the same reason — a phase that
// carries the whole prior transcript pays for it on every turn.
//
// Bounded at MAX_REPAIR_ATTEMPTS. An agent that cannot make a test pass in three tries is not going
// to on the fourth; it is going to start deleting assertions. Escalate to a human instead.

import { tierFor } from '../lib/models.mjs'
import { runClaude } from '../lib/agent.mjs'
import { MAX_REPAIR_ATTEMPTS } from '../state.mjs'

const PROMPT = (s) => `The fix for ${s.issueKey} is in the working tree, but the gate failed.

## What failed
${s.gate.summary}

${s.gate.newFailures?.length ? `## NEW failures caused by this patch\n${s.gate.newFailures.map((f) => `- ${f}`).join('\n')}` : ''}

${s.gate.preExisting?.length ? `## Ignore these — they fail on a clean \`${s.baseBranch}\` too\n${s.gate.preExisting.slice(0, 20).map((f) => `- ${f}`).join('\n')}\n` : ''}

## Output tail
\`\`\`
${(s.gate.logTail || '').slice(-6000)}
\`\`\`

## Rules
- Fix the NEW failures only. The pre-existing ones are not yours and must not be "fixed".
- You may still only edit: ${s.plan.impactedFiles.join(', ')}
${s.repro?.status === 'red' ? `- \`${s.repro.file}\` is the frozen reproducing test. It must end up PASSING and you may not edit it;
  the workflow rejects the run if its hash changes. Run it with: ${s.repro.cmd}` : ''}
- Do NOT weaken or delete an assertion to make a test pass. If the test is right and the code
  cannot satisfy it within these files, write the reason to \`.pag/escalate.txt\` and stop.
- Do not commit and do not switch branches.

Attempt ${(s.attempts ?? 0) + 1} of ${MAX_REPAIR_ATTEMPTS}.`

export function repairNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const attempts = (s.attempts ?? 0) + 1
    const tier = tierFor('repair')
    const allowance = budget.availableFor('repair')
    if (allowance <= 0.5) {
      return { attempts, refusal: { at: 'repair', reason: 'budget_exhausted', detail: `$${allowance.toFixed(2)} left before the reserve` } }
    }

    const timeMs = budget.timeFor('repair')
    if (timeMs < 60_000) {
      return { attempts, refusal: { at: 'repair', reason: 'time_budget', detail: `${(budget.timeLeftMs() / 1000).toFixed(0)}s of ${budget.maxMinutes} min left` } }
    }

    const { code, cost } = await runClaude({
      cwd: s.repo, prompt: PROMPT(s), model: tier.model, onProgress, timeoutMs: timeMs,
      budgetUsd: Math.min(allowance, allowance / (MAX_REPAIR_ATTEMPTS - attempts + 1)),
    })
    budget.charge('repair', cost, { model: tier.model, attempt: attempts, exit: code })

    return { attempts }
  }
}
