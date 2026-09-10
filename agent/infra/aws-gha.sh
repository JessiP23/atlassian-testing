#!/usr/bin/env bash
# GitHub Actions → AWS without static keys, plus a hard spending stop. Run once per AWS account, as an admin
# (your `aws sso login` session is fine). Idempotent: re-running updates what exists and creates what does not.
#
#   agent/infra/aws-gha.sh                       # defaults below
#   BUDGET_USD=500 agent/infra/aws-gha.sh        # override any knob the same way
#
# What it creates
#   1. The GitHub OIDC identity provider (token.actions.githubusercontent.com) — the repo's workflow runs
#      exchange their short-lived job token for AWS credentials that expire with the job. No key to leak.
#   2. IAM role panda-agent-gha, assumable ONLY by workflows on this repo's main branch, allowed ONLY to
#      invoke the two Bedrock models the agent uses and to read/write the runs bucket.
#   3. S3 bucket for run memory + evidence + metrics (versioned, private, evidence expires after 180 days).
#   4. A monthly Bedrock budget with an AUTOMATIC action: at 100% of the limit, AWS attaches a Deny-all-Bedrock
#      policy to the role. Runs then fail at the first model call instead of spending more. Detach the policy
#      (printed at the end) to resume after raising the limit.
#
# Then in the repo:  gh secret set AWS_ROLE_TO_ASSUME --body <role arn>   (printed at the end)
#                    gh secret delete AWS_ACCESS_KEY_ID; gh secret delete AWS_SECRET_ACCESS_KEY
# The workflow already has `id-token: write` and passes role-to-assume; with the key secrets gone it uses OIDC.
set -euo pipefail

REPO=${REPO:-JessiP23/atlassian-testing}          # owner/name of the repo that runs the workflow
BRANCH=${BRANCH:-main}                             # only runs on this branch may assume the role
ROLE=${ROLE:-panda-agent-gha}
BUCKET=${BUCKET:-assetpanda-agent-runs}
REGION=${REGION:-us-east-1}
BUDGET_USD=${BUDGET_USD:-300}                      # monthly Bedrock spend at which the kill switch fires
ALERT_EMAIL=${ALERT_EMAIL:-JMartinez@assetpanda.com}
MODELS=${MODELS:-"us.anthropic.claude-haiku-4-5-20251001-v1:0 us.anthropic.claude-opus-5"}

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# ── 1. OIDC provider ───────────────────────────────────────────────────────────────────────────────────────
say "1/4 GitHub OIDC provider in account $ACCOUNT"
OIDC_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "  exists"
else
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null   # AWS validates against GitHub's cert chain; the thumbprint is informational
  echo "  created"
fi

# ── 2. Role + least-privilege policy ───────────────────────────────────────────────────────────────────────
say "2/4 IAM role $ROLE (assumable only by $REPO@$BRANCH)"
# GitHub's token names the repo two ways. The classic subject is repo:OWNER/NAME:ref:...; the immutable one
# is repo:OWNER@OWNER_ID/NAME@REPO_ID:ref:... and is what repos issue today (a rename or a re-created repo
# with the same name does not match it — that is the point). Trust the exact immutable prefix, read from
# the repo itself, and keep the classic form so the rule keeps working whichever GitHub sends.
IMMUTABLE_PREFIX=$(gh api "repos/$REPO/actions/oidc/customization/sub" -q .sub_claim_prefix 2>/dev/null || true)
SUBS="\"repo:$REPO:ref:refs/heads/$BRANCH\""
[ -n "$IMMUTABLE_PREFIX" ] && SUBS="\"$IMMUTABLE_PREFIX:ref:refs/heads/$BRANCH\", $SUBS"
cat > "$tmp/trust.json" <<JSON
{ "Version": "2012-10-17", "Statement": [{
    "Effect": "Allow", "Action": "sts:AssumeRoleWithWebIdentity",
    "Principal": { "Federated": "$OIDC_ARN" },
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": [ $SUBS ] }
    } }] }
JSON
echo "  trusted subjects: $SUBS"
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$tmp/trust.json"; echo "  trust policy updated"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$tmp/trust.json" \
    --max-session-duration 3600 --description "GitHub Actions: panda-agent ticket runs (Bedrock + runs bucket)" >/dev/null
  echo "  created"
fi

# Model ARNs: the inference profiles the agent names, plus the foundation models they fan out to (any region).
model_arns=""
for m in $MODELS; do
  model_arns="$model_arns \"arn:aws:bedrock:$REGION:$ACCOUNT:inference-profile/$m\","
  model_arns="$model_arns \"arn:aws:bedrock:*::foundation-model/${m#us.}\","
done
cat > "$tmp/perm.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "InvokeAgentModels", "Effect": "Allow",
    "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    "Resource": [ ${model_arns} "arn:aws:bedrock:*::foundation-model/anthropic.claude-*" ] },
  { "Sid": "RunsBucket", "Effect": "Allow",
    "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::$BUCKET" },
  { "Sid": "RunsObjects", "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::$BUCKET/*" }
] }
JSON
aws iam put-role-policy --role-name "$ROLE" --policy-name panda-agent-runtime --policy-document "file://$tmp/perm.json"
echo "  inline policy panda-agent-runtime: Bedrock invoke on the agent's models, s3 get/put on $BUCKET"

# ── 3. Runs bucket ─────────────────────────────────────────────────────────────────────────────────────────
say "3/4 S3 bucket $BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then echo "  exists"; else
  if [ "$REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null; fi
  echo "  created"
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[
  {"ID":"evidence-180d","Filter":{"Prefix":"evidence/"},"Status":"Enabled","Expiration":{"Days":180}},
  {"ID":"old-versions-30d","Filter":{"Prefix":""},"Status":"Enabled","NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}' >/dev/null
echo "  private, versioned; evidence/ expires after 180 days (runs/ and metrics/ are kept)"

# ── 4. Budget + kill switch ────────────────────────────────────────────────────────────────────────────────
say "4/4 Budget panda-agent-monthly: \$$BUDGET_USD/month on Bedrock → Deny policy on $ROLE at 100%"
KILL_ARN="arn:aws:iam::$ACCOUNT:policy/panda-agent-kill"
if ! aws iam get-policy --policy-arn "$KILL_ARN" >/dev/null 2>&1; then
  aws iam create-policy --policy-name panda-agent-kill --description "Attached by the panda-agent-monthly budget action when the limit is hit" \
    --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"bedrock:*","Resource":"*"}]}' >/dev/null
fi
# Budgets needs its own role to attach the policy.
cat > "$tmp/budget-trust.json" <<JSON
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "sts:AssumeRole",
  "Principal": { "Service": "budgets.amazonaws.com" },
  "Condition": { "StringEquals": { "aws:SourceAccount": "$ACCOUNT" } } }] }
JSON
if ! aws iam get-role --role-name panda-agent-budget-action >/dev/null 2>&1; then
  aws iam create-role --role-name panda-agent-budget-action --assume-role-policy-document "file://$tmp/budget-trust.json" >/dev/null
fi
aws iam put-role-policy --role-name panda-agent-budget-action --policy-name attach-kill-switch --policy-document "{
  \"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"iam:AttachRolePolicy\",\"iam:DetachRolePolicy\"],
  \"Resource\":\"arn:aws:iam::$ACCOUNT:role/$ROLE\"}]}"
BUDGET_ROLE_ARN="arn:aws:iam::$ACCOUNT:role/panda-agent-budget-action"

cat > "$tmp/budget.json" <<JSON
{ "BudgetName": "panda-agent-monthly", "BudgetType": "COST", "TimeUnit": "MONTHLY",
  "BudgetLimit": { "Amount": "$BUDGET_USD", "Unit": "USD" },
  "CostFilters": { "Service": ["Amazon Bedrock"] },
  "CostTypes": { "IncludeCredit": false, "IncludeRefund": false, "UseAmortized": false } }
JSON
if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name panda-agent-monthly >/dev/null 2>&1; then
  aws budgets update-budget --account-id "$ACCOUNT" --new-budget "file://$tmp/budget.json"; echo "  budget updated"
else
  aws budgets create-budget --account-id "$ACCOUNT" --budget "file://$tmp/budget.json" \
    --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ALERT_EMAIL\"}]}]"
  echo "  budget created (email to $ALERT_EMAIL at 80%)"
fi
existing=$(aws budgets describe-budget-actions-for-budget --account-id "$ACCOUNT" --budget-name panda-agent-monthly \
  --query "Actions[?ActionType=='APPLY_IAM_POLICY'].ActionId" --output text 2>/dev/null || true)
if [ -n "$existing" ]; then echo "  kill-switch action exists ($existing)"; else
  # A role created seconds ago is not yet visible to the Budgets service ("permission required to assume
  # ExecutionRole") — IAM propagates in a few seconds; retry instead of failing the whole script.
  for attempt in 1 2 3 4 5 6; do
    if aws budgets create-budget-action --account-id "$ACCOUNT" --budget-name panda-agent-monthly \
        --notification-type ACTUAL --action-type APPLY_IAM_POLICY \
        --action-threshold ActionThresholdValue=100,ActionThresholdType=PERCENTAGE \
        --definition "IamActionDefinition={PolicyArn=$KILL_ARN,Roles=[$ROLE]}" \
        --execution-role-arn "$BUDGET_ROLE_ARN" --approval-model AUTOMATIC \
        --subscribers "SubscriptionType=EMAIL,Address=$ALERT_EMAIL" >/dev/null 2>"$tmp/err"; then
      echo "  kill-switch action created: at 100% AWS attaches panda-agent-kill to $ROLE automatically"; break
    fi
    if [ "$attempt" = 6 ]; then cat "$tmp/err" >&2; exit 1; fi
    echo "  waiting for IAM to propagate the execution role ($attempt/6)…"; sleep 10
  done
fi

say "Done. In the repo:"
echo "  gh secret set AWS_ROLE_TO_ASSUME --body arn:aws:iam::$ACCOUNT:role/$ROLE"
echo "  gh secret delete AWS_ACCESS_KEY_ID && gh secret delete AWS_SECRET_ACCESS_KEY   # keys gone → OIDC is the only path"
echo "  gh variable set RUNS_BUCKET --body $BUCKET"
echo
echo "After the kill switch fires and you have raised the limit:"
echo "  aws iam detach-role-policy --role-name $ROLE --policy-arn $KILL_ARN"
