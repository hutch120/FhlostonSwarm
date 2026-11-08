import { Duration, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { SwarmConfig } from "../config.js";

export interface DataStackProps extends StackProps {
  config: SwarmConfig;
}

/** Global bucket names need the account suffix; also used by stacks that cannot import the bucket. */
export const dataBucketName = (config: SwarmConfig) => `swarm-data-${config.account}`;

/** The single S3 data bucket (see PLAN.md "Where data lives"). */
export class DataStack extends Stack {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.bucket = new Bucket(this, "DataBucket", {
      bucketName: dataBucketName(props.config),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      // Versioning stays off so deletes (user data deletion) are real deletes.
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: "abort-incomplete-multipart", abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { id: "expire-test-data", prefix: "_test/", expiration: Duration.days(1) },
        // Backstops: expiry is enforced in code, these only tidy abandoned challenges and counters.
        { id: "expire-otp", prefix: "auth/otp/", expiration: Duration.days(1) },
        { id: "expire-ratelimit", prefix: "auth/ratelimit/", expiration: Duration.days(2) },
      ],
    });

    Validations.of(this.bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "Server access logs would add storage cost and a second bucket; object-level access is audited via CloudTrail management events and the app's own event log.",
    });
  }
}
