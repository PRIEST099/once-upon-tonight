#!/usr/bin/env bash
# Hosts Countertop (the open-source Alexa+-style simulator) next to the demo MCP server, so anyone can try the
# add-on in a browser: https://<id>.cloudfront.net, already pointed at the hosted MCP endpoint.
#   - Runs on the instance infra/deploy-aws.sh created, as a second systemd service (ports 5310 and 5311).
#   - Two CloudFront distributions: the app, and the MCP Apps sandbox (it must be a separate origin).
#   - A second security group admits CloudFront on 5310-5311 (one CloudFront prefix-list rule per group fits the quota).
#   - The instance role may call Claude Haiku 4.5 (Converse) and Polly, which Countertop uses to play Alexa.
#     PUBLIC_DEMO=true caps that spend per visitor per hour and for everyone per day (see countertop/server/index.ts).
# Usage: infra/deploy-countertop-aws.sh  (run infra/deploy-aws.sh first; infra/teardown-aws.sh removes this too)
set -euo pipefail
REGION=${AWS_REGION:-us-east-1}
NAME=once-upon-tonight-demo
CT=once-upon-tonight-countertop
REPO=${COUNTERTOP_REPO:-https://github.com/PRIEST099/countertop.git}
export AWS_REGION=$REGION AWS_PAGER=""
say() { printf '\n▶ %s\n' "$*"; }

INSTANCE=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
[ "$INSTANCE" = "None" ] && { echo "run infra/deploy-aws.sh first"; exit 1; }
ORIGIN=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
MCP_DOMAIN=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].DomainName | [0]" --output text)

say "Instance role: Claude Haiku 4.5 (Converse) and Polly only"
aws iam put-role-policy --role-name "$NAME-ec2" --policy-name countertop-assistant --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    { \"Effect\": \"Allow\", \"Action\": \"bedrock:InvokeModel\", \"Resource\": [
      \"arn:aws:bedrock:*:$ACCOUNT:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0\",
      \"arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0\" ] },
    { \"Effect\": \"Allow\", \"Action\": \"polly:SynthesizeSpeech\", \"Resource\": \"*\" }
  ]
}"

say "Security group: CloudFront may reach ports 5310-5311"
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$CT" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "$CT" --description "Countertop demo (CloudFront only)" --vpc-id "$VPC" --query GroupId --output text)
  PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=5310,ToPort=5311,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront}]" >/dev/null
fi
SGS=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
case " $SGS " in *" $SG "*) ;; *) aws ec2 modify-instance-attribute --instance-id "$INSTANCE" --groups $SGS "$SG" ;; esac

distribution() { # comment port → domain
  local id
  id=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$1'].Id | [0]" --output text)
  if [ "$id" = "None" ] || [ -z "$id" ]; then
    id=$(aws cloudfront create-distribution --query Distribution.Id --output text --distribution-config "{
      \"CallerReference\": \"$1-$(date +%s)\", \"Comment\": \"$1\", \"Enabled\": true, \"PriceClass\": \"PriceClass_100\",
      \"Origins\": { \"Quantity\": 1, \"Items\": [ { \"Id\": \"ec2\", \"DomainName\": \"$ORIGIN\",
        \"CustomOriginConfig\": { \"HTTPPort\": $2, \"HTTPSPort\": 443, \"OriginProtocolPolicy\": \"http-only\", \"OriginReadTimeout\": 60 } } ] },
      \"DefaultCacheBehavior\": { \"TargetOriginId\": \"ec2\", \"ViewerProtocolPolicy\": \"redirect-to-https\",
        \"AllowedMethods\": { \"Quantity\": 7, \"Items\": [\"GET\",\"HEAD\",\"OPTIONS\",\"PUT\",\"POST\",\"PATCH\",\"DELETE\"],
          \"CachedMethods\": { \"Quantity\": 2, \"Items\": [\"GET\",\"HEAD\"] } },
        \"CachePolicyId\": \"4135ea2d-6df8-44a3-9df3-4b5a84be39ad\", \"OriginRequestPolicyId\": \"b689b0a8-53d0-40ab-baf2-68738e2966ac\", \"Compress\": true }
    }")
  fi
  aws cloudfront get-distribution --id "$id" --query Distribution.DomainName --output text
}
say "CloudFront: the app and its sandbox"
APP=$(distribution "$CT" 5310)
SANDBOX=$(distribution "$CT-sandbox" 5311)
echo "app https://$APP · sandbox https://$SANDBOX"

say "Install and start Countertop on the instance (via SSM); let the MCP server accept its origin"
SCRIPT=$(cat <<EOF
set -eux
export PATH=/usr/local/bin:\$PATH
[ -d /home/app/countertop ] || sudo -u app git clone --depth 1 $REPO /home/app/countertop
cd /home/app/countertop && sudo -u app git pull --ff-only
sudo -u app env PATH=/usr/local/bin:\$PATH npm ci --no-audit --no-fund
sudo -u app env PATH=/usr/local/bin:\$PATH npx vite build
cat > /etc/countertop.env <<ENV
HOST=0.0.0.0
PORT=5310
SANDBOX_PORT=5311
AWS_REGION=$REGION
PUBLIC_DEMO=true
SANDBOX_ORIGIN=https://$SANDBOX
PUBLIC_ORIGIN=https://$APP
MCP_SERVER_URL=https://$MCP_DOMAIN/mcp
ENV
cat > /etc/systemd/system/countertop.service <<UNIT
[Unit]
Description=Countertop (public demo)
After=network-online.target
[Service]
User=app
WorkingDirectory=/home/app/countertop
EnvironmentFile=/etc/countertop.env
ExecStart=/usr/local/bin/node --import tsx server/index.ts
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
sed -i '/^ALLOWED_ORIGINS=/d' /etc/once-upon-tonight.env
echo 'ALLOWED_ORIGINS=http://localhost:*,http://127.0.0.1:*,https://$APP' >> /etc/once-upon-tonight.env
systemctl daemon-reload
systemctl enable countertop
systemctl restart countertop once-upon-tonight
sleep 5
systemctl is-active countertop once-upon-tonight
EOF
)
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 900 \
  --parameters "$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()]}))' <<<"$SCRIPT")" \
  --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" || true
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent]' --output text | tail -5

say "Waiting for CloudFront to deploy (a few minutes)"
aws cloudfront wait distribution-deployed --id "$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$CT'].Id | [0]" --output text)"
aws cloudfront wait distribution-deployed --id "$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$CT-sandbox'].Id | [0]" --output text)"
curl -fsS -o /dev/null -w "app %{http_code}\n" "https://$APP/"
echo
echo "✅ Countertop: https://$APP  (pointed at https://$MCP_DOMAIN/mcp)"
