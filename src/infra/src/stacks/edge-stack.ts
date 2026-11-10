import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  OriginProtocolPolicy,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { AaaaRecord, ARecord, type IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import {
  BlockPublicAccess,
  Bucket,
  type CfnBucket,
  BucketEncryption,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import type { SwarmConfig } from "../config.js";

export interface EdgeStackProps extends StackProps {
  config: SwarmConfig;
  zone: IHostedZone;
  /** Host name of the API's HTTP API; routed at /api/* when given. */
  apiDomain?: string;
}

const PLACEHOLDER_DIR = fileURLToPath(new URL("../../assets/placeholder", import.meta.url));
const WEB_DIST_DIR = fileURLToPath(new URL("../../../web/dist", import.meta.url));

// The real SPA when it has been built (`swarm deploy` builds it first); otherwise the placeholder.
const siteAssetDir = () => (existsSync(WEB_DIST_DIR) ? WEB_DIST_DIR : PLACEHOLDER_DIR);

// The API is same-origin (/api/*), so 'self' covers it. The live run channel is AppSync Events, which
// the browser reaches over a WebSocket in the one region we run in.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' wss://*.appsync-realtime-api.ap-southeast-2.amazonaws.com",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Private SPA bucket behind CloudFront (OAC) with security headers and the apex domain. */
export class EdgeStack extends Stack {
  readonly distribution: Distribution;
  readonly siteBucket: Bucket;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { config, zone } = props;

    this.siteBucket = new Bucket(this, "SiteBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      // Contents are rebuilt from source on every deploy.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const headers = new ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
            override: true,
          },
        ],
      },
    });

    const spaRouting = new CloudFrontFunction(this, "SpaRouting", {
      comment: "Serve index.html for client-side routes (paths whose last segment has no dot)",
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(
        [
          "function handler(event) {",
          "  var request = event.request;",
          "  var last = request.uri.split('/').pop();",
          "  if (last.indexOf('.') === -1) request.uri = '/index.html';",
          "  return request;",
          "}",
        ].join("\n"),
      ),
    });

    // The API sees the real client address (for per-IP limits) and the Origin (for CSRF checks),
    // plus the session cookies. The Host header is not forwarded: API Gateway needs its own.
    const apiOriginRequests = new OriginRequestPolicy(this, "ApiOriginRequests", {
      comment: "Cookies, query strings, Origin and the viewer address for the API",
      cookieBehavior: OriginRequestCookieBehavior.all(),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
      headerBehavior: OriginRequestHeaderBehavior.allowList(
        "Origin",
        "CloudFront-Viewer-Address",
        "X-CSRF-Token",
      ),
    });

    // The CloudFront certificate must be in us-east-1 and is created by hand (the org SCP
    // blocks CloudFormation there). Until its ARN is configured the site is served from the
    // default *.cloudfront.net domain.
    const certificate = config.cloudfrontCertificateArn
      ? Certificate.fromCertificateArn(this, "Certificate", config.cloudfrontCertificateArn)
      : undefined;

    this.distribution = new Distribution(this, "Distribution", {
      comment: "Fhloston Swarm SPA",
      defaultRootObject: "index.html",
      httpVersion: HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      minimumProtocolVersion: certificate ? SecurityPolicyProtocol.TLS_V1_2_2021 : undefined,
      domainNames: certificate ? [config.domainName] : undefined,
      certificate,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        responseHeadersPolicy: headers,
        // SPA routing: extensionless paths are served index.html. This is a function (not
        // distribution-wide error pages) so API 403/404 responses are never rewritten.
        functionAssociations: [
          { function: spaRouting, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: props.apiDomain
        ? {
            "/api/*": {
              origin: new HttpOrigin(props.apiDomain, {
                protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
              }),
              viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
              allowedMethods: AllowedMethods.ALLOW_ALL,
              cachePolicy: CachePolicy.CACHING_DISABLED,
              originRequestPolicy: apiOriginRequests,
              responseHeadersPolicy: headers,
            },
          }
        : undefined,
    });

    if (certificate) {
      const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
      new ARecord(this, "ApexA", { zone, target });
      new AaaaRecord(this, "ApexAaaa", { zone, target });
    }

    new BucketDeployment(this, "Placeholder", {
      sources: [Source.asset(siteAssetDir())],
      destinationBucket: this.siteBucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: true,
      logGroup: new LogGroup(this, "PlaceholderDeployLogs", {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR1",
      reason: "No geo restriction: the service is open to all regions.",
    });
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR2",
      reason:
        "AWS WAF is deliberately not used at launch (fixed ~US$5-10/month); see PLAN.md section 14.",
    });
    Validations.of(this.distribution).acknowledge({
      id: "AwsSolutions-CFR3",
      reason:
        "Access logging is not enabled at launch to avoid extra storage; revisit with abuse monitoring.",
    });
    if (!certificate) {
      Validations.of(this.distribution).acknowledge({
        id: "AwsSolutions-CFR4",
        reason:
          "Temporary: the default *.cloudfront.net certificate ignores the minimum TLS version. Cleared once the custom-domain certificate ARN is configured.",
      });
    }
    // The singleton Lambda that copies the placeholder is owned by the CDK library, not by us.
    const deployHandler = this.node.children.find((c) =>
      c.node.id.startsWith("Custom::CDKBucketDeployment"),
    );
    if (deployHandler) {
      const siteLogicalId = this.getLogicalId(this.siteBucket.node.defaultChild as CfnBucket);
      const reason =
        "CDK BucketDeployment handler: scoped to the CDK assets bucket and the SPA bucket.";
      for (const id of [
        "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
        "AwsSolutions-IAM5[Action::s3:GetBucket*]",
        "AwsSolutions-IAM5[Action::s3:GetObject*]",
        "AwsSolutions-IAM5[Action::s3:List*]",
        "AwsSolutions-IAM5[Action::s3:Abort*]",
        "AwsSolutions-IAM5[Action::s3:DeleteObject*]",
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*]`,
        `AwsSolutions-IAM5[Resource::<${siteLogicalId}.Arn>/*]`,
        "AwsSolutions-IAM5[Resource::*]",
        "AwsSolutions-L1",
      ]) {
        Validations.of(deployHandler).acknowledge({ id, reason });
      }
    }
    Validations.of(this.siteBucket).acknowledge({
      id: "AwsSolutions-S1",
      reason: "The SPA bucket only holds public build output; CloudFront is the access path.",
    });
  }
}
