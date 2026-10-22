#!/usr/bin/env bash
# Mixed hosted demo: Maya's stories stay pre-made (free), and a hero a visitor adds gets a real story made with
# the paid models (Claude Sonnet writes, Guardrails + Claude Haiku check, SD3.5 paints, Rekognition checks,
# Polly narrates), within a shared quota: LIVE_STORIES_PER_DAY (all visitors, rolling 24 h) and
# LIVE_STORIES_TOTAL (ever). At $0.75 to $1.05 a story (repaints included), the defaults (3 a day, 10 in all) cap the spend near $10.
# Usage: infra/enable-live-demo.sh   (after infra/deploy-aws.sh; GUARDRAIL_ID comes from .env)
set -euo pipefail
REGION=${AWS_REGION:-us-east-1}
NAME=once-upon-tonight-demo
PER_DAY=${LIVE_STORIES_PER_DAY:-3}
TOTAL=${LIVE_STORIES_TOTAL:-10}
export AWS_REGION=$REGION AWS_PAGER=""
set -a; [ -f .env ] && . ./.env; set +a
: "${GUARDRAIL_ID:?set GUARDRAIL_ID (npm run create-guardrail)}"
GUARDRAIL_VERSION=${GUARDRAIL_VERSION:-1}

INSTANCE=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

echo "▶ Instance role: exactly the models and checks the story pipeline uses"
aws iam put-role-policy --role-name "$NAME-ec2" --policy-name live-stories --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    { \"Effect\": \"Allow\", \"Action\": \"bedrock:InvokeModel\", \"Resource\": [
      \"arn:aws:bedrock:*:$ACCOUNT:inference-profile/us.anthropic.claude-sonnet-4-6\",
      \"arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*\",
      \"arn:aws:bedrock:*:$ACCOUNT:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0\",
      \"arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0\",
      \"arn:aws:bedrock:us-west-2::foundation-model/stability.sd3-5-large-v1:0\" ] },
    { \"Effect\": \"Allow\", \"Action\": \"bedrock:ApplyGuardrail\", \"Resource\": \"arn:aws:bedrock:$REGION:$ACCOUNT:guardrail/$GUARDRAIL_ID\" },
    { \"Effect\": \"Allow\", \"Action\": [\"rekognition:DetectModerationLabels\", \"polly:SynthesizeSpeech\"], \"Resource\": \"*\" }
  ]
}"

echo "▶ Server settings (via SSM), then restart"
SCRIPT=$(cat <<REMOTE
set -e
sed -i -E '/^(LIVE_NEW_HEROES|LIVE_STORIES_PER_DAY|LIVE_STORIES_TOTAL|GUARDRAIL_ID|GUARDRAIL_VERSION|AWS_REGION)=/d' /etc/once-upon-tonight.env
cat >> /etc/once-upon-tonight.env <<ENV
LIVE_NEW_HEROES=true
LIVE_STORIES_PER_DAY=$PER_DAY
LIVE_STORIES_TOTAL=$TOTAL
GUARDRAIL_ID=$GUARDRAIL_ID
GUARDRAIL_VERSION=$GUARDRAIL_VERSION
AWS_REGION=$REGION
ENV
sudo -u app git -C /home/app/once-upon-tonight pull --ff-only
systemctl restart once-upon-tonight
sleep 5
systemctl is-active once-upon-tonight
grep -E '^(LIVE_|GUARDRAIL_)' /etc/once-upon-tonight.env
REMOTE
)
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()]}))' <<<"$SCRIPT")" \
  --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" || true
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent]' --output text
echo "✅ live stories for new heroes: $PER_DAY a day, $TOTAL in all"
