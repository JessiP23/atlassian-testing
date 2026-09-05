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
in priorFix, and set confidence "low": a re-open needs the engineer who shipped it, not a second
independent guess.

Return JSON:
{"summary":str,"acceptanceCriteria":[str],"constraints":[str],"nonGoals":[str],
 "symptom":{"screen":str,"errorText":str,"inputs":[str],"layer":"web-app"|"import-template"|"backend"|"unknown","why":str},
 "reopened":bool,"priorFix":str,
 "riskNotes":[str],"testPlan":[str],"confidence":"high"|"medium"|"low"}`

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
      'COMMENTS:',
      ...(ticket.comments || []).slice(0, 8).map((c, i) => `[${i + 1}] ${c.author}: ${c.body.slice(0, 1500)}`),
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

    // A re-open is the one shape where a fresh start is worse than no start: the first fix's author
    // holds the context (ESI2-3194: chaining + loop guard shipped under ESI2-3156, QA confirmed
    // twice, customer still failing). Hand it back with the prior fix named.
    // A deliberate override for when a human has decided to point the agent at a re-open anyway.
    if (data.reopened && process.env.PAG_ALLOW_REOPEN === '1') {
      console.error(`      re-open detected${data.priorFix ? ` (${data.priorFix})` : ''} — continuing because PAG_ALLOW_REOPEN=1`)
    } else if (data.reopened) {
      return {
        ticket, spec: data, ticketShots,
        refusal: {
          at: 'intake', reason: 'ticket_reopened',
          detail: `A fix for this was already shipped${data.priorFix ? ` (${data.priorFix})` : ''} and the customer reports it still failing. `
            + 'This needs the engineer who shipped it, not a second independent attempt.',
        },
      }
    }

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
