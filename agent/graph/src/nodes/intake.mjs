// Ticket -> executable spec. Runs on the FAST tier: this is summarisation of text we already have.
//
// Cost note: on run ESI2-3376 this phase ("triage") cost $1.05 on Opus 5 and produced an excellent
// brief. The brief's quality came from the CODE READING it did, not from the model's strength on
// the summarisation itself. So this node does the summarisation only; the code reading has moved to
// the locate node where it is deterministic and free.

import { converseJson } from '../lib/bedrock.mjs'
import { tierFor, estimateCost } from '../lib/models.mjs'
import { fetchIssue, probeIssue } from '../lib/jira.mjs'

const SYSTEM = `You convert a bug/feature ticket into an executable spec for a code-fixing agent.

Rules:
- Ground every claim in the ticket text. Never invent reproduction steps or file names.
- acceptanceCriteria must be individually checkable by a test or a human clicking through.
- nonGoals is where you put the tempting adjacent refactor. Be specific about what NOT to touch.
- If the ticket is too vague to act on, say so in riskNotes and set confidence "low".

Return JSON:
{"summary":str,"acceptanceCriteria":[str],"constraints":[str],"nonGoals":[str],
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
    ].join('\n')

    const { data, inTok, outTok } = await converseJson({
      model: tier.model, system: SYSTEM, user, maxTokens: tier.maxTokens,
    })
    budget.charge('intake', estimateCost(tier, inTok, outTok), { model: tier.model, inTok, outTok })

    if (data.confidence === 'low') {
      return {
        ticket, spec: data,
        refusal: {
          at: 'intake',
          reason: 'ticket_underspecified',
          detail: data.riskNotes?.join('; ') || 'model reported low confidence on the spec',
        },
      }
    }
    return { ticket, spec: data }
  }
}
