#!/usr/bin/env bash
# Backend deploys from GitHub Actions into the company DEV account — without static keys.
# Run ONCE by an admin of the dev account (aws sso login as that admin, then this script).
#
# How pioneer deploys today: CI holds static AWS keys and runs `aws sts assume-role` into
# arn:aws:iam::<account>:role/ap-cicd-cross-account-deployment (scripts/cicd/switch-account.sh); developers deploy
# backend versions from laptops with SSO. This script keeps the SAME deploy role and only changes who may reach it:
#
#   GitHub OIDC token (repo + branch pinned) ──assume──▶ panda-agent-deploy ──assume──▶ ap-cicd-cross-account-deployment
#
# No key exists anywhere; credentials live as long as one job. `panda-agent-deploy` itself can do nothing except
# assume the existing deploy role, so nothing about what a deploy may touch changes.
#
#   agent/infra/aws-deploy-role.sh                       # dev account 362202801688, repo JessiP23/atlassian-testing
#   REPO=AssetPandaLLC/panda-agent agent/infra/aws-deploy-role.sh   # after the repo moves into the org
set -euo pipefail

REPO=${REPO:-JessiP23/atlassian-testing}
BRANCH=${BRANCH:-main}
ROLE=${ROLE:-panda-agent-deploy}
DEPLOY_ROLE=${DEPLOY_ROLE:-ap-cicd-cross-account-deployment}
EXPECT_ACCOUNT=${EXPECT_ACCOUNT:-362202801688}   # dev; refuse to run anywhere else by accident

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "$EXPECT_ACCOUNT" ] || { echo "signed into $ACCOUNT, expected dev $EXPECT_ACCOUNT — switch profile (or set EXPECT_ACCOUNT)"; exit 1; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

say "1/3 GitHub OIDC provider in $ACCOUNT"
OIDC_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then echo "  exists"; else
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null; echo "  created"; fi

say "2/3 Role $ROLE — assumable only by $REPO@$BRANCH, allowed only to assume $DEPLOY_ROLE"
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
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$tmp/trust.json"; echo "  trust updated"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$tmp/trust.json" --max-session-duration 3600 \
    --description "GitHub Actions (panda-agent): may only assume $DEPLOY_ROLE to deploy per-ticket backend versions" >/dev/null; echo "  created"
fi
DEPLOY_ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$DEPLOY_ROLE"
aws iam put-role-policy --role-name "$ROLE" --policy-name assume-deploy-role --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Resource\":\"$DEPLOY_ROLE_ARN\"}]}"
echo "  trusted subjects: $SUBS"

say "3/3 Let $ROLE assume $DEPLOY_ROLE (one statement appended to its trust policy; nothing else changes)"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"
aws iam get-role --role-name "$DEPLOY_ROLE" --query Role.AssumeRolePolicyDocument > "$tmp/deploy-trust.json"
if jq -e --arg a "$ROLE_ARN" '.Statement[] | select(.Principal.AWS? == $a or (.Principal.AWS? | type=="array" and index($a)))' "$tmp/deploy-trust.json" >/dev/null; then
  echo "  already trusted"
else
  jq --arg a "$ROLE_ARN" '.Statement += [{"Sid":"PandaAgentDeploy","Effect":"Allow","Principal":{"AWS":$a},"Action":"sts:AssumeRole"}]' \
    "$tmp/deploy-trust.json" > "$tmp/deploy-trust.new.json"
  echo "  --- current"; jq -c '.Statement[]' "$tmp/deploy-trust.json"
  echo "  +++ adding";  jq -c '.Statement[-1]' "$tmp/deploy-trust.new.json"
  aws iam update-assume-role-policy --role-name "$DEPLOY_ROLE" --policy-document "file://$tmp/deploy-trust.new.json"
  echo "  applied"
fi

say "Done. Send Jessi:  $ROLE_ARN"
echo "Workflow side (already supported): secret AWS_DEPLOY_ROLE_TO_ASSUME=$ROLE_ARN; the job assumes it via OIDC, then"
echo "  aws sts assume-role --role-arn $DEPLOY_ROLE_ARN --role-session-name panda-agent   # exactly what scripts/cicd/switch-account.sh does"
