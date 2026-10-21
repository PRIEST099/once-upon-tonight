#!/usr/bin/env bash
# Deletes everything infra/deploy-aws.sh created (CloudFront distribution, EC2 instance, security group, IAM role).
set -euo pipefail
REGION=${AWS_REGION:-us-east-1}
NAME=once-upon-tonight-demo
export AWS_REGION=$REGION AWS_PAGER=""

DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)
if [ "$DIST" != "None" ] && [ -n "$DIST" ]; then
  ETAG=$(aws cloudfront get-distribution-config --id "$DIST" --query ETag --output text)
  aws cloudfront get-distribution-config --id "$DIST" --query DistributionConfig > /tmp/$NAME-dist.json
  python3 -c "import json;p='/tmp/$NAME-dist.json';c=json.load(open(p));c['Enabled']=False;json.dump(c,open(p,'w'))"
  aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config file:///tmp/$NAME-dist.json >/dev/null
  echo "disabling CloudFront $DIST (takes a few minutes)…"
  aws cloudfront wait distribution-deployed --id "$DIST"
  aws cloudfront delete-distribution --id "$DIST" --if-match "$(aws cloudfront get-distribution --id "$DIST" --query ETag --output text)"
fi

INSTANCE=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$INSTANCE" != "None" ]; then
  aws ec2 terminate-instances --instance-ids "$INSTANCE" >/dev/null
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE"
fi

SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" --query 'SecurityGroups[0].GroupId' --output text)
[ "$SG" != "None" ] && aws ec2 delete-security-group --group-id "$SG"

if aws iam get-role --role-name "$NAME-ec2" >/dev/null 2>&1; then
  aws iam remove-role-from-instance-profile --instance-profile-name "$NAME-ec2" --role-name "$NAME-ec2" || true
  aws iam delete-instance-profile --instance-profile-name "$NAME-ec2" || true
  aws iam detach-role-policy --role-name "$NAME-ec2" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam delete-role --role-name "$NAME-ec2"
fi
echo "✅ torn down"
