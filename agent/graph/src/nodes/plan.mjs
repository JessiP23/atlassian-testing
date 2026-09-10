// Spec + located files -> a minimal plan with an EXPLICIT impactedFiles allowlist.
// Fast tier: the hard thinking already happened in intake and locate; this is structuring.
//
// impactedFiles is the load-bearing output. It becomes the guard's allowlist (lib/guard.mjs), so
// a patch that wanders outside it is caught on the real git diff rather than argued about in a
// prompt. This is the mechanism that stops "fix one ternary" from becoming 52 files.

import fs from 'node:fs'
import path from 'node:path'
import { converseJson } from '../lib/bedrock.mjs'
import { tierFor, estimateCost } from '../lib/models.mjs'
import { DIFF_LIMITS } from '../lib/guard.mjs'
import { loadProfile } from '../../profiles/index.mjs'
import { recentCommits, relatedTickets, historyBlock } from '../lib/history.mjs'

// Soft target given to the planner. The hard cap in guard.mjs still applies to the real diff; this
// is what keeps a plan from ballooning to 8 files and a 21k-token context pack.
const PLAN_FILE_TARGET = Number(process.env.PAG_PLAN_FILE_TARGET || 5)

const SYSTEM = `You write a minimal implementation plan for a bug fix or small feature.

Hard rules:
- impactedFiles is a CONTRACT. The patch step is mechanically forbidden from touching anything not
  listed. List only PRODUCTION files you will edit — test files go in newTests and are allowed
  automatically, so do not list them twice.
- Fewer files is better. Every file you list is loaded in full into the next step's context, so an
  8-file plan costs several times what a 4-file plan costs and usually indicates the root cause was
  not isolated. If you cannot get under the budget, that is a signal to set needsEscalation.
- Prefer the smallest change that satisfies the acceptance criteria. No adjacent refactors.
- newTests must include at least one test that FAILS before the fix and passes after. Name the
  exact condition it pins.
- If satisfying the criteria genuinely needs more than the stated file/line budget, do not pad the
  plan — set needsEscalation true and explain.

Hypotheses before files. A bug report describes a SYMPTOM; the code usually offers two or three
distinct mechanisms that could produce it. Name them in hypotheses, most likely first, each with:
- statement: the mechanism, in one sentence, naming the function or branch involved;
- check: the concrete input and assertion that would tell this hypothesis apart from the others;
- checkable: "test" if a unit test at this level can run that check on this repo; "browser" if only a
  running app can; "data" if it needs the customer's configuration or data that the ticket does not
  contain (say what is missing). Do NOT call a check "test" when it really needs the customer's data.
impactedFiles serves H1; the reproducing test runs H1's check first and moves to H2 if H1 does not
reproduce. A single hypothesis is allowed only when the code offers no alternative — say so in steps.

Return JSON:
{"hypotheses":[{"id":"H1","statement":str,"check":str,"checkable":"test"|"browser"|"data"}],
 "impactedFiles":[str],"steps":[str],"newTests":[{"file":str,"pins":str}],
 "migrationNotes":str,"needsEscalation":bool,"escalationReason":str}`

export function planNode({ budget, onProgress = () => {} }) {
  return async (s) => {
    const tier = tierFor('plan')

    // Read only the located files, and only a bounded slice of each. This is the "smallest context
    // that could work" rule — broaden later only if the gate points elsewhere.
    // On a re-plan, the escalated files matter more than the router's original picks — patch has
    // READ the code and named them, which is stronger evidence than any retrieval score. They are
    // put first so the line budget favours them.
    const esc = s.escalation
    const targets = esc?.neededFiles?.length
      ? [
          ...esc.neededFiles.map((p) => ({ path: p, reason: 'named by the patch step as where the fix must go' })),
          ...s.located.filter((l) => !esc.neededFiles.includes(l.path)),
        ]
      : s.located

    const bodies = targets.map(({ path: p, reason }) => {
      const abs = path.join(s.repo, p)
      let text = ''
      try { text = fs.readFileSync(abs, 'utf8') } catch { text = '(unreadable)' }
      const lines = text.split('\n')
      const clipped = lines.length > 400 ? [...lines.slice(0, 400), `... (${lines.length - 400} more lines)`].join('\n') : text
      return `--- ${p}  (picked because: ${reason})\n${clipped}`
    })

    const sym = s.spec.symptom || {}
    // History is cheap and runs while nothing else does: git log on the candidates, and the tracker's
    // own memory of this symptom. Off with PAG_HISTORY=0 (e.g. a shallow clone with no Jira token).
    let history = ''
    if (process.env.PAG_HISTORY !== '0') {
      const [commits, related] = await Promise.all([
        recentCommits(s.repo, targets.map((t) => t.path)),
        relatedTickets({ issueKey: s.issueKey, summary: s.spec.summary, terms: [sym.screen, ...(sym.inputs || []).slice(0, 2)] }),
      ])
      history = historyBlock({ commits, related })
      onProgress(`history: ${commits.reduce((n, c) => n + c.commits.length, 0)} commit(s) on ${commits.length} file(s); related tickets: ${related.tickets?.length ? related.tickets.map((t) => t.key).join(', ') : related.error ? `search failed (${related.error})` : 'none found'}`)
    }
    const user = [
      `SPEC: ${s.spec.summary}`,
      sym.screen
        ? `SYMPTOM: on "${sym.screen}"${sym.errorText ? `, the error reads "${sym.errorText}"` : ''}${sym.inputs?.length ? `; values involved: ${sym.inputs.join(', ')}` : ''}.`
          + ` Likely layer: ${sym.layer || 'unknown'}${sym.why ? ` (${sym.why})` : ''}.`
          + ' Every file in impactedFiles must be on the code path that produces THAT screen for THOSE values.'
          + ' If none of the candidates is, set needsEscalation and say which layer the fix must live in.'
        : '',
      (s.spec.carry || []).length
        ? `UNMERGED PRIOR FIX — carry it: ${s.spec.carry.map((c) => `PR #${c.number} (${c.state}) "${c.title}" changed ${c.files.join(', ') || 'no product files'}`).join('; ')}.`
          + ' That change is NOT on the base branch, so this ticket has TWO defects: the one that PR addressed and the one the'
          + ' customer reported afterwards. impactedFiles must cover both — include the files above AND the path the later report names.'
        : '',
      s.spec.reopened
        ? `RE-OPEN: a fix already shipped (${s.spec.priorFix || 'see the ticket comments'}) and the customer still reports the failure.`
          + ' Do NOT redo that fix. Find the path it did not cover — the customer\'s actual trigger source, data shape or'
          + ' configuration — and the impactedFiles must be on THAT path. Say in riskNotes what the prior fix assumed.'
        : '',
      `ACCEPTANCE CRITERIA:\n${(s.spec.acceptanceCriteria || []).map((a, i) => `  ${i + 1}. ${a}`).join('\n')}`,
      `NON-GOALS:\n${(s.spec.nonGoals || []).map((a) => `  - ${a}`).join('\n')}`,
      `BUDGET: at most ${PLAN_FILE_TARGET} production files in impactedFiles (hard cap ${DIFF_LIMITS.maxFiles}),`,
      `        and ${DIFF_LIMITS.maxLines} changed lines total. Tests are separate and unlimited.`,
      '',
      'CANDIDATE FILES:',
      ...bodies,
      ...(history ? ['', history] : []),
      ...(esc ? [
        '',
        '## THIS IS A RE-PLAN — the first plan could not be implemented',
        '',
        `The ${esc.from || 'patch'} step read the code and stopped without editing anything, because ${esc.from === 'reproduce'
          ? 'the files the previous plan allowed cannot produce the ticket\'s symptom for the ticket\'s inputs'
          : 'the fix is not reachable from the files the previous plan allowed'}. Its analysis follows. Treat it as the`,
        'strongest available evidence: it comes from reading the actual code, not from retrieval.',
        '',
        `Previously allowed (insufficient): ${s.plan?.impactedFiles?.join(', ') || '(none)'}`,
        `It says it needs: ${esc.neededFiles.join(', ') || '(named no usable file)'}`,
        '',
        '```',
        String(esc.text).slice(0, 6000),
        '```',
        '',
        'Produce a plan that CAN be implemented: impactedFiles must include the files it named,',
        'unless its reasoning is demonstrably wrong — in which case set needsEscalation with why.',
        'Do not re-issue the previous plan, and do not add a workaround in the previously-allowed',
        'files: it explained why that is a regression risk with no benefit.',
      ] : []),
    ].join('\n')

    const { data, inTok, outTok } = await converseJson({
      model: tier.model, system: SYSTEM, user, maxTokens: tier.maxTokens,
    })
    budget.charge('plan', estimateCost(tier, inTok, outTok), { model: tier.model, inTok, outTok })

    if (data.needsEscalation) {
      return { plan: data, refusal: { at: 'plan', reason: 'needs_escalation', detail: data.escalationReason } }
    }
    if (!data.impactedFiles?.length) {
      return { plan: data, refusal: { at: 'plan', reason: 'empty_plan', detail: 'planner named no files to change' } }
    }
    // A repo with NO unit test runner must not be handed a plan that demands unit tests.
    //
    // KAN-11: `profile.testOne` returns null here (no jest, no vitest), but the plan still listed
    // `newTests`, so the patch session spent most of its 420s trying to find a way to run them —
    // it read this workflow's own source looking for a test command, built a scratch project in
    // /tmp to try `node --experimental-strip-types --test`, and wrote a TypeScript loader hook.
    // All of that was work the ticket never asked for, and the session was killed mid-edit.
    //
    // The witness (a Playwright spec against the running app) is this repo's evidence rung and it
    // has already run by the time patch starts. Asking for unit tests on top is asking for a test
    // harness, which is its own ticket.
    if (!loadProfile(s.repo).hasUnitRunner(s.repo) && data.newTests?.length) {
      onProgress(`plan asked for ${data.newTests.length} unit test(s) but this repo has no test runner — dropping them; the browser witness is the evidence rung here`)
      data.newTests = []
    }

    // Drop any test files the planner put in impactedFiles anyway — they belong in newTests, and
    // counting them against the production budget skews the context pack.
    const { isTestFile } = await import('../lib/guard.mjs')
    const prod = data.impactedFiles.filter((f) => !isTestFile(f))
    const strays = data.impactedFiles.filter((f) => isTestFile(f))
    if (strays.length) {
      data.newTests = [...(data.newTests || []), ...strays.map((f) => ({ file: f, pins: 'moved from impactedFiles' }))]
      data.impactedFiles = prod
    }
    // Defensive: a re-plan that drops the escalated files would loop straight back to the same
    // escalation. Merge them in rather than trusting the model to remember.
    if (esc?.neededFiles?.length && !esc.neededFiles.every((f) => data.impactedFiles.includes(f))) {
      data.impactedFiles = [...new Set([...esc.neededFiles, ...data.impactedFiles])]
    }
    // And a re-plan must not FORGET the first plan either: on ESI2-3194 the first plan targeted the
    // TypeError in the automation handler, patch escalated for the changeType files the red test
    // needed, and the re-plan returned only those — the second defect silently fell out of the run.
    // Both halves stay in scope; the width cap below still applies.
    // An unmerged prior fix travels with the ticket: its product files are in scope whatever the
    // model picked (r10 on ESI2-3194 read the risk note and still planned only the new defect).
    const carried = (s.spec?.carry || []).flatMap((c) => c.files).filter((f) => fs.existsSync(path.join(s.repo, f)) && !data.impactedFiles.includes(f))
    if (carried.length) { data.impactedFiles = [...data.impactedFiles, ...carried]; onProgress?.(`carrying ${carried.length} file(s) from the unmerged prior fix: ${carried.map((f) => path.basename(f)).join(', ')}`) }
    if (esc && s.plan?.impactedFiles?.length) {
      const prev = s.plan.impactedFiles.filter((f) => fs.existsSync(path.join(s.repo, f)))
      data.impactedFiles = [...new Set([...data.impactedFiles, ...prev])]
    }

    if (data.impactedFiles.length > DIFF_LIMITS.maxFiles) {
      return { plan: data, refusal: { at: 'plan', reason: 'plan_too_wide', detail: `${data.impactedFiles.length} production files exceeds the ${DIFF_LIMITS.maxFiles} cap — the root cause was not isolated` } }
    }
    // Hypotheses: bounded, well-formed, ids normalised. A re-plan keeps the earlier verdicts.
    const prior = new Map((s.plan?.hypotheses || []).map((h) => [h.statement, h]))
    data.hypotheses = (Array.isArray(data.hypotheses) ? data.hypotheses : [])
      .filter((h) => h && h.statement).slice(0, 4)
      .map((h, i) => ({ id: `H${i + 1}`, statement: String(h.statement).slice(0, 300), check: String(h.check || '').slice(0, 300),
        checkable: ['test', 'browser', 'data'].includes(h.checkable) ? h.checkable : 'test',
        ...(prior.get(h.statement)?.verdict ? { verdict: prior.get(h.statement).verdict, evidence: prior.get(h.statement).evidence } : {}) }))
    if (data.hypotheses.length) onProgress(`${data.hypotheses.length} hypothesis(es): ${data.hypotheses.map((h) => `${h.id} [${h.checkable}]`).join(', ')}`)

    // Clear the escalation so the next patch attempt starts clean, and count the re-plan.
    return { plan: data, escalation: null, replans: (s.replans ?? 0) + (esc ? 1 : 0) }
  }
}
