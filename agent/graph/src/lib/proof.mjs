// The proof ledger: what this run PROVED, what it INFERRED, and what it could NOT verify here.
//
// Derived from verdicts already in state — the red/green logs, the gate, browser QA's status, the
// ticket's attachments — never from prose, so every line traces to a file a reviewer can open. This is
// the section a reviewer reads first: it says how much of the PR is demonstrated and how much is the
// agent's reading of the code. ESI2-3437 is why it exists — the only evidence on that ticket was a
// Zoom recording the agent could not read, and the PR did not say so.

const firstLine = (t) => String(t || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
const firstSentence = (t) => (firstLine(t).match(/^.*?[.!?](\s|$)/) || [firstLine(t)])[0].trim()
const short = (sha) => String(sha || '').slice(0, 7)

/** @returns {{confirmed:{claim,source}[], inferred:{claim,basis}[], unverified:{claim,how}[]}} */
export function proofFromState(s) {
  const confirmed = [], inferred = [], unverified = []

  // ---- what the ticket gave us --------------------------------------------------------------
  const sym = s.spec?.symptom || {}
  if (sym.screen) {
    confirmed.push({
      claim: `Symptom as reported: ${sym.screen}${sym.errorText ? ` — "${sym.errorText}"` : ''}`,
      source: (s.ticketShots || []).length ? 'ticket text and screenshots' : 'ticket text',
    })
  }
  for (const a of (s.ticket?.attachments || []).filter((x) => !/^image\//.test(x.mimeType || ''))) {
    unverified.push({
      claim: `Attachment "${a.filename}" (${a.mimeType || 'unknown type'}) was not read by the agent`,
      how: 'open it — it may show the customer\'s actual configuration or steps',
    })
  }

  // ---- reproduction -----------------------------------------------------------------------------
  if (s.repro?.status === 'red') {
    confirmed.push({
      claim: `A test reproduces the defect on ${short(s.baseSha)}: \`${s.repro.file}\`${s.repro.reusedFrom ? ` (written in run ${s.repro.reusedFrom}, re-run red on this base)` : ''}`,
      source: 'evidence/repro-red.log',
    })
    if (s.evidence?.reproGreen) {
      confirmed.push({ claim: 'The same test passes with the patch; the owning projects lint, test and build green', source: 'evidence/repro-green.log · evidence/gate.log' })
    } else if (s.incomplete) {
      unverified.push({ claim: 'The reproducing test is still red — the patch does not make it pass', how: 'this is a hand-over, not a fix' })
    }
  } else {
    unverified.push({ claim: 'No reproducing test: the defect was not demonstrated before the fix', how: 'review the diff against the acceptance criteria' })
  }

  // ---- the agent's reading of the cause ----------------------------------------------------------
  if (s.patchReport) {
    inferred.push({ claim: `Root cause as the agent read it: ${firstSentence(s.patchReport).slice(0, 300)}`, basis: `code reading; ${(s.changed || []).length} file(s) changed` })
  }
  for (const h of s.plan?.hypotheses || []) {
    if (h.verdict === 'confirmed') confirmed.push({ claim: `Hypothesis held: ${h.statement}`, source: h.evidence || 'reproducing test' })
    else if (h.verdict === 'rejected') inferred.push({ claim: `Ruled out: ${h.statement}`, basis: h.evidence || 'its check did not reproduce the symptom' })
    else if (h.checkable !== 'test' || s.repro?.status !== 'red') unverified.push({ claim: `Not ruled in or out: ${h.statement}`, how: h.check || 'needs data the run did not have' })
  }

  // ---- the browser --------------------------------------------------------------------------------
  const qa = s.qa || {}
  const shots = (qa.shots || []).length
  if (qa.status === 'passed') {
    confirmed.push({ claim: `The fix was exercised in a real browser: ${shots} captioned screenshot(s), ticket steps pass`, source: 'browser QA screenshots' })
  } else if (qa.status === 'observed') {
    confirmed.push({ claim: `Reproduced on the unpatched qa backend today${qa.summary ? `: ${firstSentence(qa.summary).slice(0, 240)}` : ''}`, source: `${shots} browser QA screenshot(s)` })
    unverified.push({ claim: 'The fix itself was not exercised against a running backend — qa does not carry this branch', how: 'deploy the branch as a version and re-run QA, or verify manually once merged to qa' })
  } else if (qa.status === 'bugs_unresolved') {
    unverified.push({ claim: `Browser QA could not confirm the fix${qa.summary ? `: ${firstSentence(qa.summary).slice(0, 240)}` : ''}`, how: 'read the QA summary before reviewing' })
  } else if (qa.status) {
    unverified.push({ claim: `Browser QA did not complete (${qa.status})${qa.reason ? `: ${qa.reason}` : ''}`, how: 'verify the ticket steps by hand' })
  } else if (s.spec) {
    unverified.push({ claim: 'Browser QA did not run', how: qa.reason || 'verify the ticket steps by hand' })
  }

  // ---- what the ticket left open (bounded) -------------------------------------------------------
  for (const note of (s.spec?.riskNotes || []).slice(0, 4)) unverified.push({ claim: note, how: '' })

  return { confirmed, inferred, unverified }
}

/** Markdown for the PR body. Empty groups are stated, not hidden. */
export function proofBlock(p) {
  const item = (x) => `- ${x.claim}${x.source ? ` — _${x.source}_` : x.basis ? ` — _${x.basis}_` : x.how ? ` — ${x.how}` : ''}`
  return [
    '## What is proven, inferred, and not verified',
    '',
    `**Proven** (${p.confirmed.length})`,
    ...(p.confirmed.length ? p.confirmed.map(item) : ['- nothing — read the diff as a proposal']),
    '',
    `**Inferred by the agent** (${p.inferred.length})`,
    ...(p.inferred.length ? p.inferred.map(item) : ['- none stated']),
    '',
    `**Not verified here** (${p.unverified.length}) — a human should check these`,
    ...(p.unverified.length ? p.unverified.map(item) : ['- nothing outstanding']),
  ].join('\n')
}
