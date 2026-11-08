import { fileURLToPath } from "node:url";
import { Duration, Fn, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
import { HttpApi, HttpMethod, HttpStage, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  OutputFormat,
  type NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { ConfigurationSet } from "aws-cdk-lib/aws-ses";
import { type ITopic, Subscription, SubscriptionProtocol } from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";
import type { SwarmConfig } from "../config.js";
import { dataBucketName } from "./data-stack.js";

export interface ApiStackProps extends StackProps {
  config: SwarmConfig;
  configurationSet: ConfigurationSet;
  feedbackTopic: ITopic;
}

const API_SRC = fileURLToPath(new URL("../../../api/src/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Keys the API may touch. Nothing else in the data bucket is reachable from the web-facing Lambda.
const API_PREFIXES = ["users", "auth", "claims", "suppression"] as const;

/** The auth API: Hono on Lambda behind an HTTP API, plus the SES bounce/complaint handler. */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  /** Host name of the HTTP API, used as the CloudFront origin for /api/*. */
  readonly apiDomain: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, configurationSet, feedbackTopic } = props;
    const bucketName = dataBucketName(config);
    const bucketArn = `arn:${this.partition}:s3:::${bucketName}`;
    const { api } = config;

    const environment: Record<string, string> = {
      DATA_BUCKET: bucketName,
      SITE_ORIGIN: `https://${config.domainName}`,
      PEPPER_PARAMETER: api.pepperParameter,
      JWT_PARAMETER: api.jwtKeyParameter,
      MAIL_FROM: api.mailFrom,
      MAIL_REPLY_TO: api.mailReplyTo,
      SES_CONFIGURATION_SET: configurationSet.configurationSetName,
      ...(api.turnstileSecretParameter
        ? { TURNSTILE_SECRET_PARAMETER: api.turnstileSecretParameter }
        : {}),
    };

    const common = (name: string): NodejsFunctionProps => ({
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment,
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}package-lock.json`,
      logGroup: new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: false,
        mainFields: ["module", "main"],
        // ESM bundles still need `require` for a few CommonJS dependencies.
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    const secretArns = [api.pepperParameter, api.jwtKeyParameter, api.turnstileSecretParameter]
      .filter((p): p is string => p !== null)
      .map((p) =>
        this.formatArn({ service: "ssm", resource: "parameter", resourceName: p.slice(1) }),
      );
    const readSecrets = [
      new PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: secretArns,
      }),
      // SecureStrings use the AWS-managed aws/ssm key, whose ARN is not known at synth time.
      new PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
      }),
    ];
    const objectArns = (prefixes: readonly string[]) => prefixes.map((p) => `${bucketArn}/${p}/*`);
    const bucketAccess = (prefixes: readonly string[], actions: string[]) => [
      new PolicyStatement({ actions, resources: objectArns(prefixes) }),
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [bucketArn],
        conditions: { StringLike: { "s3:prefix": prefixes.map((p) => `${p}/*`) } },
      }),
    ];

    const apiFunction = new NodejsFunction(this, "ApiFunction", {
      ...common("ApiFunction"),
      entry: `${API_SRC}lambda.ts`,
      handler: "handler",
      description: "Swarm API (Hono): auth, sessions, account",
    });
    for (const statement of [
      ...readSecrets,
      ...bucketAccess(API_PREFIXES, ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]),
      new PolicyStatement({
        actions: ["ses:SendEmail"],
        // In the SES sandbox the recipient's identity is authorised too, hence identity/*.
        resources: [
          this.formatArn({ service: "ses", resource: "identity", resourceName: "*" }),
          this.formatArn({
            service: "ses",
            resource: "configuration-set",
            resourceName: configurationSet.configurationSetName,
          }),
        ],
        conditions: { StringEquals: { "ses:FromAddress": api.mailFrom } },
      }),
    ]) {
      apiFunction.addToRolePolicy(statement);
    }

    const feedbackFunction = new NodejsFunction(this, "FeedbackFunction", {
      ...common("FeedbackFunction"),
      entry: `${API_SRC}feedback.ts`,
      handler: "handler",
      description: "Writes suppression entries for SES bounces and complaints",
    });
    for (const statement of [
      ...readSecrets,
      ...bucketAccess(["suppression"], ["s3:GetObject", "s3:PutObject"]),
    ]) {
      feedbackFunction.addToRolePolicy(statement);
    }
    // Created here (not via topic.addSubscription) so the Ses and Api stacks do not depend on each other.
    feedbackFunction.addPermission("SesFeedback", {
      principal: new ServicePrincipal("sns.amazonaws.com"),
      sourceArn: feedbackTopic.topicArn,
    });
    new Subscription(this, "FeedbackSubscription", {
      topic: feedbackTopic,
      protocol: SubscriptionProtocol.LAMBDA,
      endpoint: feedbackFunction.functionArn,
    });

    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: "swarm-api",
      description: "Swarm API, reached through CloudFront at /api/*",
      createDefaultStage: false,
    });
    this.httpApi.addRoutes({
      path: "/api/{proxy+}",
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration("ApiIntegration", apiFunction),
    });
    const accessLogs = new LogGroup(this, "AccessLogs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const stage = new HttpStage(this, "DefaultStage", {
      httpApi: this.httpApi,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: api.throttle.rateLimit, burstLimit: api.throttle.burstLimit },
    });
    (stage.node.defaultChild as CfnStage).accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      // Timing and status only: no paths with query strings, headers, IPs or bodies.
      format: JSON.stringify({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status",
        latencyMs: "$context.responseLatency",
        integrationError: "$context.integrationErrorMessage",
      }),
    };

    this.apiDomain = Fn.select(2, Fn.split("/", this.httpApi.apiEndpoint));

    // Nothing here is a managed policy we can tighten further without losing function.
    const reason =
      "Scoped to this stack's functions; wildcards are limited to the data prefixes and SES identities the API needs.";
    for (const fn of [apiFunction, feedbackFunction]) {
      Validations.of(fn).acknowledge({
        id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
        reason: "Standard Lambda logging role; the function logs to its own 30-day log group.",
      });
      for (const id of [
        "AwsSolutions-IAM5[Resource::*]",
        ...API_PREFIXES.map(
          (p) => `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${bucketName}/${p}/*]`,
        ),
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ses:${this.region}:${this.account}:identity/*]`,
      ]) {
        Validations.of(fn).acknowledge({ id, reason });
      }
    }
    Validations.of(this.httpApi).acknowledge({
      id: "AwsSolutions-APIG4",
      reason:
        "Authentication is done by the application (OTP + signed session cookies); /api/auth/* must be public.",
    });
    Validations.of(stage).acknowledge({
      id: "AwsSolutions-APIG1",
      reason: "Access logging is enabled via the CfnStage override.",
    });
  }
}
