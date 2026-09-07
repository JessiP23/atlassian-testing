// Ticket -> executable spec. Runs on the FAST tier: this is summarisation of text we already have.
//
// Cost note: on run ESI2-3376 this phase ("triage") cost $1.05 on Opus 5 and produced an excellent
// brief. The brief's quality came from the CODE READING it did, not from the model's strength on
// the summarisation itself. So this node does the summarisation only; the code reading has moved to
// the locate node where it is deterministic and free.

import { converseJson } from '../lib/bedrock.mjs'
import { tierFor, estimateCost } from '../lib/models.mjs'
import { fetchIssue, probeIssue, fetchAttachmentImages } from '../lib/jira.mjs'
import { saveEvidence } from '../lib/repro.mjs'

const SYSTEM = `You convert a bug/feature ticket into an executable spec for a code-fixing agent.

Rules:
- Ground every claim in the ticket text AND its screenshots. Never invent reproduction steps, values
  or file names. When the screenshots are attached, READ them: they usually carry the exact error
  text, the screen it appears on, the field's configuration and the value that failed.
- acceptanceCriteria must be individually checkable by a test or a human clicking through.
- nonGoals is where you put the tempting adjacent refactor. Be specific about what NOT to touch.
- confidence is about whether there is a SYMPTOM to act on, not about whether you know the cause.
  Finding the cause is the next four steps' job, and no customer bug report contains it. "the exact
  regex is not visible", "no CSV was attached", "the root cause is unknown" are normal and belong in
  riskNotes with confidence "high" or "medium". Set "low" ONLY when there is nothing concrete to
  reproduce: no error text, no named screen, no values, no acceptance criteria you could check.

symptom is the load-bearing field. It tells the code search WHERE to look and the test writer WHAT
must fail. Fill it from the navigation steps and the screenshots:
- screen: the exact UI surface the user is on when the symptom shows (e.g. "OneSchema import
  field-mapping step after clicking Next", "record View Full Details tab bar", "Automation logs").
  Name the step number from the ticket. If the symptom is a wrong value with no error, say so.
- errorText: the error message verbatim if one is shown (from text or screenshot), else "".
- inputs: the concrete values involved — the cell value, field name and configuration, record id,
  role name. Only values that appear in the ticket or its images. Empty array if none.
- layer: your best reading of where the defect must live given the screen: "web-app" (rendered in the
  browser), "import-template" (a validation rule shipped to the import widget), "backend" (a lambda
  or library that runs after the click), or "unknown". Say why in one clause.

reopened: a NARROW test, and all three parts must hold:
  1. a comment describes a fix that actually LANDED — merged, deployed, released, "fixed in <ticket>";
  2. someone confirmed it was working (QA, the reporter, an engineer);
  3. a LATER comment says the customer still sees the issue.
An open or draft PR is NOT a shipped fix. A root-cause analysis is NOT a shipped fix. A list of
attempts with no merge is NOT a shipped fix. If any of the three is missing, reopened is false —
say what you saw in riskNotes instead. When all three hold, set reopened true, name the shipped fix
in priorFix, and put in riskNotes what that fix assumed and what the customer's later report says
differently — that gap is where the remaining bug lives. Do not lower confidence for a re-open.

Return JSON:
{"summary":str,"acceptanceCriteria":[str],"constraints":[str],"nonGoals":[str],
 "symptom":{"screen":str,"errorText":str,"inputs":[str],"layer":"web-app"|"import-template"|"backend"|"unknown","why":str},
 "reopened":bool,"priorFix":str,
 "riskNotes":[str],"testPlan":[str],"confidence":"high"|"medium"|"low"}`

// The comments the model reads, as prompt lines: the first two (how the ticket was raised) and the
// newest ones, with an explicit gap line so a skipped run of comments is visible rather than silent.
// Numbering follows the ticket so a reference like "comment [9]" means the same thing to everyone.
export function commentLines(comments, max = 10, chars = 2000) {
  const line = (c, i) => `[${i + 1}] ${c.author}: ${String(c.body || '').slice(0, chars)}`
  if (comments.length <= max) return comments.map(line)
  const tail = comments.length - (max - 2)
  return [...comments.slice(0, 2).map(line), `(… ${tail - 2} older comment(s) omitted …)`, ...comments.slice(tail).map((c, k) => line(c, tail + k))]
}

/** PRs (#NNNN) mentioned in `text` that GitHub says are not merged, as { number, state }. Silent on any failure — this is a check, never a blocker. */
export async function unmergedPrs(text) {
  const slug = (process.env.PAG_ALLOWED_REMOTE || '').trim()
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const nums = [...new Set([...String(text).matchAll(/#(\d{3,6})\b/g)].map((m) => m[1]))].slice(0, 5)
  if (!slug || !token || !nums.length) return []
  const out = []
  for (const n of nums) {
    try {
      const r = await fetch(`https://api.github.com/repos/${slug}/pulls/${n}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) continue
      const pr = await r.json()
      if (!pr.merged) out.push({ number: n, state: pr.draft ? 'draft' : pr.state })
    } catch { /* offline or no access: say nothing */ }
  }
  return out
}

export function intakeNode({ budget }) {
  return async (s) => {
    const tier = tierFor('intake')
    const ticket = await fetchIssue(s.issueKey)

    if (!ticket) {
      // "unreachable" alone sends you looking at the wrong thing. Probe and say which it is.
      const p = await probeIssue(s.issueKey).catch((e) => ({ verdict: e.message }))
      return { refusal: { at: 'intake', reason: 'ticket_unreachable', detail: `${s.issueKey}: ${p.verdict}` } }
    }

    // An Epic is a container. ESI2-18 ("Automations") and ESI2-2204 ("Attachments") have no
    // description and no symptom; the tickets that do are their children. Nothing downstream can
    // act on a container, so say so here instead of letting locate search for the word "Automations".
    if (/^epic$/i.test(ticket.issuetype || '')) {
      return { ticket, refusal: { at: 'intake', reason: 'ticket_is_epic',
        detail: `${ticket.key} is an Epic ("${ticket.summary}") — a container, not a bug. Run one of its child tickets.` } }
    }

    // The screenshots. Bounded (6 images, 2 MB each); a failed download is a missing image, not a
    // failed run. See fetchAttachmentImages for why this exists.
    const images = await fetchAttachmentImages(ticket).catch(() => [])
    if (ticket.agentComments) console.error(`      ignoring ${ticket.agentComments} comment(s) this agent wrote on earlier runs`)

    // Keep them. They are the only picture of the bug AS REPORTED, and on a ticket where the agent
    // cannot drive the UI they are the only picture at all. Saved into evidence/ so pushEvidence
    // carries them to the evidence branch like any other artefact, and the PR can show them beside
    // whatever the run proved. `ticket-NN-` sorts them into the reporter's own order.
    const ticketShots = images.map((img, i) => {
      const safe = String(img.filename || `image-${i + 1}`).replace(/[^\w.-]+/g, '-').slice(-60)
      const file = `ticket-${String(i + 1).padStart(2, '0')}-${safe.endsWith(`.${img.format}`) ? safe : `${safe}.${img.format}`}`
      return saveEvidence(file, img.bytes) ? { file, name: img.filename || file } : null
    }).filter(Boolean)

    // Bounded input. Comments are the useful signal (a colleague's root-cause note often IS the
    // answer) but they are also where the corpus embeds credentials — 87% of our tickets did — so
    // fetchIssue() redacts at the fetch boundary before anything reaches a model.
    const user = [
      `KEY: ${ticket.key}`,
      `TYPE: ${ticket.issuetype}   PRIORITY: ${ticket.priority}   STATUS: ${ticket.status}`,
      `SUMMARY: ${ticket.summary}`,
      '',
      'DESCRIPTION:',
      (ticket.description || '(none)').slice(0, 6000),
      '',
      // Newest comments carry the most: on a re-opened ticket the finding that explains why the last
      // fix did not hold is the LAST comment, and `slice(0, 8)` cut exactly that one off ESI2-3194
      // (a CloudWatch stack trace in comment 9 of 9). Keep the first two for the original context
      // and the newest for the rest; the model sees the gap when one exists.
      'COMMENTS (oldest first; numbering follows the ticket):',
      ...commentLines(ticket.comments || []),
      ...(ticket.comments || []).length ? [] : ['(no human comments on this ticket)'],
      '',
      images.length
        ? `SCREENSHOTS (${images.length}, attached in order): ${images.map((i) => i.filename).join(', ')}`
        : 'SCREENSHOTS: none readable',
    ].join('\n')

    const { data, inTok, outTok } = await converseJson({
      model: tier.model, system: SYSTEM, user, maxTokens: tier.maxTokens, images,
    })
    budget.charge('intake', estimateCost(tier, inTok, outTok), { model: tier.model, inTok, outTok })
    if (images.length) console.error(`      read ${images.length} screenshot(s) from the ticket`)
    if (data.symptom?.screen) console.error(`      symptom: ${data.symptom.screen}${data.symptom.errorText ? ` — "${data.symptom.errorText}"` : ''} [${data.symptom.layer || 'unknown'}]`)

    // A re-open is CONTEXT, not a stop. A human pointed the agent at this ticket on purpose; the
    // prior fix and the "still failing" report are the most valuable facts in the thread, and the
    // plan gets them (see plan.mjs) so the work is "what did the shipped fix miss", never a redo.
    // The model reads "PR #15846 opened" and writes "merged and deployed" — it did on ESI2-3194, and
    // the plan then fixed only the NEW finding, leaving the unmerged half off main. Merge state is a
    // fact GitHub knows, not something to infer from a thread: check every PR the prior fix names.
    if (data.reopened && data.priorFix) {
      const unmerged = await unmergedPrs(data.priorFix)
      if (unmerged.length) {
        data.riskNotes = [...(data.riskNotes || []), `${unmerged.map((u) => `PR #${u.number}`).join(', ')} named as the prior fix ${unmerged.length > 1 ? 'are' : 'is'} ${unmerged.map((u) => u.state).join('/')} — NOT merged, so that change is not on the base branch. The fix here must include it, not assume it.`]
        data.priorFix = `${data.priorFix} (${unmerged.map((u) => `#${u.number} ${u.state}, not merged`).join('; ')})`
        data.reopened = false
        console.error(`      prior fix named ${unmerged.map((u) => `#${u.number}`).join(', ')} — GitHub says ${unmerged.map((u) => u.state).join('/')}, not merged; treating the ticket as OPEN, both halves in scope`)
      }
    }
    if (data.reopened) console.error(`      re-open: ${data.priorFix || 'a prior fix'} shipped and the customer still reports it — planning around what it missed`)

    // Low confidence is a WARNING unless the ticket really gives nothing to reproduce.
    //
    // ESI2-3393 refused here with "the exact regex is not visible", "no CSV was provided", "the
    // root cause is unknown" — an accurate description of every customer bug report ever filed, and
    // of a ticket the agent had already fixed correctly twice. A spec that names the screen, quotes
    // the error and lists the failing values IS actionable; the unknowns it lists are the next four
    // steps' job. Refusing on them refuses the work.
    const sym = data.symptom || {}
    const actionable = Boolean(sym.errorText || sym.screen || (sym.inputs || []).length || (data.acceptanceCriteria || []).length)
    if (data.confidence === 'low' && !actionable) {
      return {
        ticket, spec: data, ticketShots,
        refusal: {
          at: 'intake',
          reason: 'ticket_underspecified',
          detail: data.riskNotes?.join('; ') || 'the ticket names no error, no screen and no checkable criterion',
        },
      }
    }
    if (data.confidence === 'low') {
      console.error(`      low confidence, but the ticket is actionable — continuing. Unknowns go in the PR: ${(data.riskNotes || []).slice(0, 2).join('; ').slice(0, 160)}`)
    }
    if (ticketShots.length) console.error(`      kept ${ticketShots.length} ticket screenshot(s) for the PR`)
    return { ticket, spec: data, ticketShots }
  }
}
