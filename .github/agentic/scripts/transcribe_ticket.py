#!/usr/bin/env python3
"""Transcribe a Jira payload into a faithful ticket brief using Bedrock Haiku."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import boto3

SCHEMA_HINT = """
Return ONLY valid JSON with these keys:
key, summary, issue_type, priority, status, issue_url, assignee, reporter,
labels (array), parent_key, verbatim_summary, verbatim_description,
acceptance_criteria (array of strings), scope_in (array), scope_out (array),
constraints (array), ambiguities (array), files_hint (array), ready_for_dev (boolean).

Rules:
- verbatim_summary MUST be the ticket summary copied exactly.
- verbatim_description MUST be the ticket description copied exactly (empty string if missing).
- Do not invent acceptance criteria. Extract them only if the description or
  acceptance_criteria field already contains them.
- If criteria are missing, use [] and add an ambiguity saying they are missing.
- ready_for_dev is true only when the ticket has a clear summary and either
  acceptance criteria or a description specific enough to implement.
- files_hint may list paths mentioned in the ticket; otherwise [].
- Never rewrite the reporter's wording in verbatim_* fields.
"""


def payload_from_env() -> dict:
    raw = os.environ.get("JIRA_PAYLOAD_JSON", "").strip()
    if raw:
        return json.loads(raw)
    return {
        "issue_key": os.environ.get("ISSUE_KEY", ""),
        "summary": os.environ.get("ISSUE_SUMMARY", ""),
        "description": os.environ.get("ISSUE_DESCRIPTION", ""),
        "issue_type": os.environ.get("ISSUE_TYPE", ""),
        "priority": os.environ.get("ISSUE_PRIORITY", ""),
        "status": os.environ.get("ISSUE_STATUS", ""),
        "issue_url": os.environ.get("ISSUE_URL", ""),
        "acceptance_criteria": os.environ.get("ISSUE_ACCEPTANCE_CRITERIA", ""),
        "labels": os.environ.get("ISSUE_LABELS", ""),
        "assignee": os.environ.get("ISSUE_ASSIGNEE", ""),
        "reporter": os.environ.get("ISSUE_REPORTER", ""),
        "parent_key": os.environ.get("ISSUE_PARENT_KEY", ""),
    }


def fallback_brief(payload: dict) -> dict:
    summary = str(payload.get("summary") or "").strip()
    description = str(payload.get("description") or "").strip()
    criteria_raw = payload.get("acceptance_criteria") or ""
    if isinstance(criteria_raw, list):
        criteria = [str(item).strip() for item in criteria_raw if str(item).strip()]
    else:
        criteria = [line.strip(" -*\t") for line in str(criteria_raw).splitlines() if line.strip()]
    key = str(payload.get("issue_key") or payload.get("key") or "UNKNOWN")
    ready = bool(summary) and bool(description or criteria)
    ambiguities = []
    if not description:
        ambiguities.append("Description is empty.")
    if not criteria:
        ambiguities.append("No explicit acceptance criteria were provided.")
    return {
        "key": key,
        "summary": summary,
        "issue_type": str(payload.get("issue_type") or "Task"),
        "priority": str(payload.get("priority") or "unspecified"),
        "status": str(payload.get("status") or "unspecified"),
        "issue_url": str(payload.get("issue_url") or ""),
        "assignee": payload.get("assignee") or None,
        "reporter": payload.get("reporter") or None,
        "labels": (
            [str(item).strip() for item in payload.get("labels") if str(item).strip()]
            if isinstance(payload.get("labels"), list)
            else [part.strip() for part in str(payload.get("labels") or "").split(",") if part.strip()]
        ),
        "parent_key": payload.get("parent_key") or None,
        "verbatim_summary": summary,
        "verbatim_description": description,
        "acceptance_criteria": criteria,
        "scope_in": [],
        "scope_out": [],
        "constraints": [],
        "ambiguities": ambiguities,
        "files_hint": [],
        "ready_for_dev": ready,
    }


def invoke_haiku(payload: dict) -> dict:
    model_id = os.environ["BEDROCK_HAIKU_MODEL"]
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    client = boto3.client("bedrock-runtime", region_name=region)
    user = (
        "Transcribe this Jira ticket into the JSON schema. "
        "Copy summary and description verbatim.\n\n"
        f"{SCHEMA_HINT}\n\nTICKET:\n{json.dumps(payload, indent=2)}"
    )
    response = client.converse(
        modelId=model_id,
        messages=[{"role": "user", "content": [{"text": user}]}],
        inferenceConfig={"maxTokens": 2000, "temperature": 0},
        system=[{"text": "You are a ticket transcriber. You copy source text faithfully and extract structure. You never invent requirements."}],
    )
    text = response["output"]["message"]["content"][0]["text"].strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    brief = json.loads(text)
    # Preserve verbatim fields even if the model paraphrases.
    brief["verbatim_summary"] = str(payload.get("summary") or brief.get("verbatim_summary") or "")
    brief["verbatim_description"] = str(payload.get("description") or brief.get("verbatim_description") or "")
    brief["key"] = str(payload.get("issue_key") or payload.get("key") or brief.get("key") or "UNKNOWN")
    brief["summary"] = brief["verbatim_summary"]
    return brief


def render_markdown(brief: dict) -> str:
    def bullets(values: list) -> str:
        if not values:
            return "- None"
        return "\n".join(f"- {item}" for item in values)

    return f"""# Ticket brief — {brief.get('key')}

## Identity
- Key: `{brief.get('key')}`
- Type: {brief.get('issue_type')}
- Priority: {brief.get('priority')}
- Status: {brief.get('status')}
- URL: {brief.get('issue_url') or 'n/a'}
- Assignee: {brief.get('assignee') or 'n/a'}
- Reporter: {brief.get('reporter') or 'n/a'}
- Labels: {', '.join(brief.get('labels') or []) or 'none'}
- Ready for dev: {brief.get('ready_for_dev')}

## Verbatim summary
{brief.get('verbatim_summary') or '(empty)'}

## Verbatim description
{brief.get('verbatim_description') or '(empty)'}

## Acceptance criteria
{bullets(brief.get('acceptance_criteria') or [])}

## Scope in
{bullets(brief.get('scope_in') or [])}

## Scope out
{bullets(brief.get('scope_out') or [])}

## Constraints
{bullets(brief.get('constraints') or [])}

## Ambiguities
{bullets(brief.get('ambiguities') or [])}

## Files hinted by the ticket
{bullets(brief.get('files_hint') or [])}
"""


def main() -> int:
    out_dir = Path(os.environ.get("RUN_DIR", ".github/agentic/run"))
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = payload_from_env()
    if not payload.get("issue_key") and not payload.get("summary"):
        print("Missing issue_key/summary in Jira payload", file=sys.stderr)
        return 1

    try:
        brief = invoke_haiku(payload)
    except Exception as exc:  # noqa: BLE001 — fall back to a faithful extract
        print(f"Haiku transcription failed, using deterministic extract: {exc}", file=sys.stderr)
        brief = fallback_brief(payload)

    (out_dir / "ticket-brief.json").write_text(json.dumps(brief, indent=2) + "\n")
    (out_dir / "ticket-brief.md").write_text(render_markdown(brief))
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(f"issue_key={brief.get('key')}\n")
            handle.write(f"ready_for_dev={str(brief.get('ready_for_dev')).lower()}\n")
            handle.write(f"summary={brief.get('summary')}\n")
    print(f"Wrote brief for {brief.get('key')} ready_for_dev={brief.get('ready_for_dev')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
