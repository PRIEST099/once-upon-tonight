#!/usr/bin/env bash
# Public demo of Once Upon Tonight on AWS:
#   Amazon EC2 (t4g.nano, Amazon Linux 2023, arm64) runs the MCP server from this GitHub repo
#   Amazon CloudFront in front of it provides HTTPS (https://<id>.cloudfront.net/mcp)
#   The security group only admits CloudFront (managed origin-facing prefix list); no SSH: managed via SSM.
# Demo mode (AI_MODE=mock): anyone can link the demo family and read the bundled story; no Bedrock spend.
# Cost: roughly $7/month (instance + 8 GB disk + public IPv4); CloudFront stays within its free tier.
# Usage: infra/deploy-aws.sh            (idempotent-ish: reuses resources that already exist)
#        infra/teardown-aws.sh          (deletes everything this script created)
set -euo pipefail
REGION=${AWS_REGION:-us-east-1}
NAME=once-upon-tonight-demo
REPO=${REPO:-https://github.com/PRIEST099/once-upon-tonight.git}
PORT=8787
export AWS_REGION=$REGION AWS_PAGER=""

say() { printf '\n▶ %s\n' "$*"; }

say "IAM role for SSM (no SSH keys needed)"
if ! aws iam get-role --role-name "$NAME-ec2" >/dev/null 2>&1; then
  aws iam create-role --role-name "$NAME-ec2" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$NAME-ec2" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name "$NAME-ec2" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$NAME-ec2" --role-name "$NAME-ec2"
  sleep 10 # instance profile propagation
fi

say "Security group: only CloudFront may reach port $PORT"
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "Once Upon Tonight demo (CloudFront only)" --vpc-id "$VPC" --query GroupId --output text)
  PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront}]" >/dev/null
fi

say "EC2 instance"
INSTANCE=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$INSTANCE" = "None" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  SECRET=$(openssl rand -hex 24)
  USERDATA=$(cat <<EOF
#!/bin/bash
set -eux
# 1 GB swap so npm install + the Vite build fit in 512 MB of RAM
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
dnf install -y git tar xz
# Official Node.js 22 LTS build (Vite needs 20.19+ / 22.12+)
curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1
useradd -m app
sudo -u app git clone --depth 1 $REPO /home/app/once-upon-tonight
cd /home/app/once-upon-tonight
sudo -u app env PATH=/usr/local/bin:\$PATH npm ci --no-audit --no-fund
sudo -u app env PATH=/usr/local/bin:\$PATH npm run build:app
cat > /etc/once-upon-tonight.env <<ENV
PUBLIC_URL=http://localhost:$PORT
HOST=0.0.0.0
PORT=$PORT
AI_MODE=mock
DEMO_MODE=true
# Pace the bundled story's studio steps so visitors can watch the progress.
MOCK_STEP_MS=5000
# Only CloudFront can reach the instance (security group), so trust its X-Forwarded-For for rate limits.
TRUST_PROXY=1
ALEXA_CLIENT_SECRET=$SECRET
ENV
cat > /etc/systemd/system/once-upon-tonight.service <<UNIT
[Unit]
Description=Once Upon Tonight MCP server (demo)
After=network-online.target
[Service]
User=app
WorkingDirectory=/home/app/once-upon-tonight
EnvironmentFile=/etc/once-upon-tonight.env
ExecStart=/usr/local/bin/node --import tsx src/server.ts
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now once-upon-tonight
EOF
)
  INSTANCE=$(aws ec2 run-instances --image-id "$AMI" --instance-type t4g.nano \
    --security-group-ids "$SG" --iam-instance-profile Name="$NAME-ec2" \
    --metadata-options HttpTokens=required \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --user-data "$USERDATA" --query 'Instances[0].InstanceId' --output text)
fi
aws ec2 wait instance-running --instance-ids "$INSTANCE"
ORIGIN=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
echo "instance $INSTANCE · origin $ORIGIN"

say "CloudFront distribution (HTTPS, caching off, all headers except Host forwarded)"
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)
if [ "$DIST" = "None" ] || [ -z "$DIST" ]; then
  CONFIG=$(cat <<EOF
{
  "CallerReference": "$NAME-$(date +%s)",
  "Comment": "$NAME",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "Origins": { "Quantity": 1, "Items": [ {
    "Id": "ec2", "DomainName": "$ORIGIN",
    "CustomOriginConfig": { "HTTPPort": $PORT, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only", "OriginReadTimeout": 30 }
  } ] },
  "DefaultCacheBehavior": {
    "TargetOriginId": "ec2",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": { "Quantity": 7, "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"], "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] } },
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "Compress": true
  }
}
EOF
)
  DIST=$(aws cloudfront create-distribution --distribution-config "$CONFIG" --query Distribution.Id --output text)
fi
DOMAIN=$(aws cloudfront get-distribution --id "$DIST" --query Distribution.DomainName --output text)
echo "distribution $DIST · https://$DOMAIN"

say "Point the server at its public URL (via SSM; waits for the agent to register)"
for i in $(seq 1 60); do
  STATUS=$(aws ssm describe-instance-information --filters Key=InstanceIds,Values="$INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text)
  [ "$STATUS" = "Online" ] && break
  sleep 10
done
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "commands=[\"until systemctl is-active once-upon-tonight; do sleep 5; done\",\"sed -i 's#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#' /etc/once-upon-tonight.env\",\"systemctl restart once-upon-tonight\"]" \
  --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$INSTANCE" || true

say "Waiting for CloudFront to deploy (a few minutes)"
aws cloudfront wait distribution-deployed --id "$DIST"
curl -fsS "https://$DOMAIN/health" && echo
echo
echo "✅ MCP endpoint: https://$DOMAIN/mcp   (demo family: parent@example.com / bedtime)"
