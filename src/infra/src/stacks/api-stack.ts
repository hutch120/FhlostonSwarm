import { fileURLToPath } from "node:url";
import {
  ArnFormat,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type CfnElement,
  type StackProps,
  Validations,
} from "aws-cdk-lib";
import { learningConfig, runtimeConfig } from "@swarm/shared/server";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { HttpApi, HttpMethod, HttpStage, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpIamAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AppSyncAuthorizationType, EventApi, type ChannelNamespace } from "aws-cdk-lib/aws-appsync";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime, type IFunction } from "aws-cdk-lib/aws-lambda";
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
import { AGENT_FAMILY, RUN_CLUSTER, RUN_STATE_MACHINE } from "../names.js";
import { dataBucketName } from "./data-stack.js";

export interface ApiStackProps extends StackProps {
  config: SwarmConfig;
  configurationSet: ConfigurationSet;
  feedbackTopic: ITopic;
}

const API_SRC = fileURLToPath(new URL("../../../api/src/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Keys the web-facing API may touch. Nothing else in the data bucket is reachable from it.
const API_PREFIXES = ["users", "auth", "suppression"] as const;
// Closing a run also writes the anonymised cost index.
const ADMIN_WRITE_PREFIXES = ["admin"] as const;
/** Concurrency pool state (read and written with compare-and-swap by every function that starts or ends a run). */
const POOL_PREFIX = "admin/pools";
/** The dynamic layer (learned items and agents): global, kept apart from every customer's data. */
const LEARNING_PREFIX = "learning";
/** The anonymised run index, which the learning pass adds its own cost line to. */
const RUN_INDEX_PREFIX = "admin/run-index";
/** What staff change in the dashboard and every function reads when it acts on it: controls and the price table. */
const OPS_READ_PREFIXES = ["admin/settings", "admin/pricing"] as const;
/** The day's spend, added to by every function that closes a run, for the daily spend alarm. */
const SPEND_PREFIX = "admin/spend";

/**
 * The API: Hono on Lambda behind an HTTP API, the IAM-protected internal API the agent tasks call,
 * the live channel (AppSync Events), the orchestration Lambdas (prepare, finalize, reaper) and the
 * SES bounce/complaint handler. The state machine and the ECS cluster live in SwarmRuns, which
 * depends on this stack; this stack refers to them by their fixed names.
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  /** Host name of the HTTP API, used as the CloudFront origin for /api/*. */
  readonly apiDomain: string;
  /** `https://<id>.execute-api.<region>.amazonaws.com`: where agent tasks call the internal API. */
  readonly internalApiBase: string;
  readonly internalInvokeArn: string;
  readonly prepareFunction: IFunction;
  readonly finalizeFunction: IFunction;
  readonly learnFunction: IFunction;
  readonly reaperFunction: IFunction;
  readonly eventApi: EventApi;
  readonly runsNamespace: ChannelNamespace;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, configurationSet, feedbackTopic } = props;
    const bucketName = dataBucketName(config);
    const bucketArn = `arn:${this.partition}:s3:::${bucketName}`;
    const { api } = config;

    const stateMachineArn = this.formatArn({
      service: "states",
      resource: "stateMachine",
      resourceName: RUN_STATE_MACHINE,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const executionArn = this.formatArn({
      service: "states",
      resource: "execution",
      resourceName: `${RUN_STATE_MACHINE}:*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const secretEnvironment = {
      DATA_BUCKET: bucketName,
      SITE_ORIGIN: `https://${config.domainName}`,
      PEPPER_PARAMETER: api.pepperParameter,
      JWT_PARAMETER: api.jwtKeyParameter,
    };

    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: "swarm-api",
      description: "Swarm API, reached through CloudFront at /api/*",
      createDefaultStage: false,
    });
    this.internalApiBase = `https://${this.httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`;
    this.internalInvokeArn = this.formatArn({
      service: "execute-api",
      resource: this.httpApi.apiId,
      resourceName: "*/*/api/internal/*",
    });
    const mailEnvironment = {
      MAIL_FROM: api.mailFrom,
      MAIL_REPLY_TO: api.mailReplyTo,
      SES_CONFIGURATION_SET: configurationSet.configurationSetName,
    };

    const common = (
      name: string,
      overrides: Partial<NodejsFunctionProps> = {},
    ): NodejsFunctionProps => ({
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment: { ...secretEnvironment, ...mailEnvironment },
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
      ...overrides,
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
    /** Invoking `au.` inference profiles by id, in either Australian region, and only through the profile. */
    const bedrockInvoke = (profileIds: readonly string[]) => {
      const profiles = profileIds.map(
        (id) =>
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${id}`,
      );
      return [
        new PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: profiles }),
        new PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: profileIds.map(
            (id) =>
              `arn:${this.partition}:bedrock:*::foundation-model/${id.replace(/^[a-z]+\./, "")}`,
          ),
          conditions: { StringLike: { "bedrock:InferenceProfileArn": profiles } },
        }),
      ];
    };
    const sendMail = new PolicyStatement({
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
    });
    const clusterArn = this.formatArn({
      service: "ecs",
      resource: "cluster",
      resourceName: RUN_CLUSTER,
    });
    const taskArns = this.formatArn({
      service: "ecs",
      resource: "task",
      resourceName: `${RUN_CLUSTER}/*`,
    });

    // Live channel -------------------------------------------------------------------------

    const streamAuthFunction = new NodejsFunction(this, "StreamAuthFunction", {
      ...common("StreamAuthFunction", { memorySize: 256, timeout: Duration.seconds(5) }),
      entry: `${API_SRC}stream-auth-lambda.ts`,
      handler: "handler",
      description: "Authorizes browsers for one run's live channel (AppSync Events)",
    });
    for (const statement of readSecrets) streamAuthFunction.addToRolePolicy(statement);

    this.eventApi = new EventApi(this, "EventApi", {
      apiName: "swarm-events",
      authorizationConfig: {
        authProviders: [
          {
            authorizationType: AppSyncAuthorizationType.LAMBDA,
            lambdaAuthorizerConfig: {
              handler: streamAuthFunction,
              resultsCacheTtl: Duration.minutes(1),
            },
          },
          { authorizationType: AppSyncAuthorizationType.IAM },
        ],
        connectionAuthModeTypes: [AppSyncAuthorizationType.LAMBDA],
        // Only the platform publishes (IAM); browsers subscribe with a per-run token.
        defaultPublishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [AppSyncAuthorizationType.LAMBDA],
      },
    });
    this.runsNamespace = this.eventApi.addChannelNamespace("runs");
    const eventsEnvironment = {
      EVENTS_HTTP_DOMAIN: this.eventApi.httpDns,
      EVENTS_REALTIME_DOMAIN: this.eventApi.realtimeDns,
    };

    // The web-facing API -------------------------------------------------------------------

    const apiFunction = new NodejsFunction(this, "ApiFunction", {
      ...common("ApiFunction", {
        // Stopping a run closes it (reads the whole event log, writes the report), so allow more time.
        timeout: Duration.seconds(29),
        environment: {
          ...secretEnvironment,
          ...mailEnvironment,
          ...eventsEnvironment,
          ...(api.turnstileSecretParameter
            ? { TURNSTILE_SECRET_PARAMETER: api.turnstileSecretParameter }
            : {}),
          STATE_MACHINE_ARN: stateMachineArn,
          ECS_CLUSTER: RUN_CLUSTER,
        },
      }),
      entry: `${API_SRC}lambda.ts`,
      handler: "handler",
      description: "Swarm API (Hono): auth, sessions, targets, scans, runs, reports, account",
    });
    for (const statement of [
      ...readSecrets,
      ...bucketAccess(API_PREFIXES, ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]),
      // The staff dashboard reads the run index, audit log, controls and price tables, and writes
      // the controls, price versions and audit records; closing a run writes the index.
      ...bucketAccess(ADMIN_WRITE_PREFIXES, ["s3:GetObject", "s3:PutObject"]),
      // Staff roll back, pin and disable entries of the learning layer from the dashboard.
      ...bucketAccess([LEARNING_PREFIX], ["s3:GetObject", "s3:PutObject"]),
      // Health reads the SES and Bedrock metrics (CloudWatch metric reads have no resource scope).
      new PolicyStatement({ actions: ["cloudwatch:GetMetricStatistics"], resources: ["*"] }),
      sendMail,
      new PolicyStatement({ actions: ["states:StartExecution"], resources: [stateMachineArn] }),
      new PolicyStatement({ actions: ["states:StopExecution"], resources: [executionArn] }),
      new PolicyStatement({
        actions: ["ecs:ListTasks"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": clusterArn } },
      }),
      new PolicyStatement({
        actions: ["ecs:DescribeTasks", "ecs:StopTask"],
        resources: [taskArns],
      }),
    ]) {
      apiFunction.addToRolePolicy(statement);
    }
    this.eventApi.grantPublish(apiFunction);

    // The agent tasks' API (IAM) ------------------------------------------------------------

    const internalFunction = new NodejsFunction(this, "InternalFunction", {
      ...common("InternalFunction", {
        timeout: Duration.seconds(20),
        environment: { ...secretEnvironment, ...eventsEnvironment },
      }),
      entry: `${API_SRC}internal-lambda.ts`,
      handler: "handler",
      description: "Agent task API: run input, event ingestion, evidence (IAM + run token)",
    });
    for (const statement of [
      ...readSecrets,
      ...bucketAccess(["users"], ["s3:GetObject", "s3:PutObject"]),
      // The depth's caps as staff have them now.
      ...bucketAccess(OPS_READ_PREFIXES, ["s3:GetObject"]),
      // Pins the run to a version of the dynamic layer (and creates the first one on first use).
      ...bucketAccess([LEARNING_PREFIX], ["s3:GetObject", "s3:PutObject"]),
    ]) {
      internalFunction.addToRolePolicy(statement);
    }
    this.eventApi.grantPublish(internalFunction);

    // Orchestration Lambdas, called by the state machine and the schedule -------------------

    const orchestratorEnvironment = {
      ...secretEnvironment,
      ...mailEnvironment,
      ...eventsEnvironment,
      ECS_CLUSTER: RUN_CLUSTER,
      AGENT_FAMILY,
      STATE_MACHINE_ARN: stateMachineArn,
      INTERNAL_API_BASE: this.internalApiBase,
    };
    const orchestrator = (
      name: string,
      handler: string,
      overrides: Partial<NodejsFunctionProps>,
      description: string,
    ) =>
      new NodejsFunction(this, name, {
        ...common(name, overrides),
        entry: `${API_SRC}orchestrator.ts`,
        handler,
        description,
      });
    const prepare = orchestrator(
      "PrepareFunction",
      "prepare",
      { timeout: Duration.seconds(15), environment: orchestratorEnvironment },
      "Run step 1: confirms the run and mints its run token",
    );
    const finalize = orchestrator(
      "FinalizeFunction",
      "finalize",
      { memorySize: 1024, timeout: Duration.minutes(2), environment: orchestratorEnvironment },
      "Run last step: report, cost, anonymised index, notice",
    );
    const reaper = orchestrator(
      "ReaperFunction",
      "reaper",
      { memorySize: 1024, timeout: Duration.minutes(3), environment: orchestratorEnvironment },
      "Stops tasks and executions that outlived their run, and closes their runs",
    );
    const learn = orchestrator(
      "LearnFunction",
      "learn",
      {
        memorySize: 1024,
        // The pass has its own hard limit (learning.json); this only has to be longer.
        timeout: Duration.seconds(learningConfig.learner.timeoutSeconds + 30),
        environment: orchestratorEnvironment,
      },
      "Run step after the PDF: the learning pass reviews the closed run and may publish a new version of the dynamic layer",
    );
    this.prepareFunction = prepare;
    this.finalizeFunction = finalize;
    this.learnFunction = learn;
    this.reaperFunction = reaper;
    for (const fn of [prepare, finalize, reaper, learn]) {
      for (const statement of [
        ...readSecrets,
        ...bucketAccess(["users"], ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]),
        ...bucketAccess([POOL_PREFIX], ["s3:GetObject", "s3:PutObject"]),
        // The kill switch, concurrency and the price table in force.
        ...bucketAccess(OPS_READ_PREFIXES, ["s3:GetObject"]),
      ]) {
        fn.addToRolePolicy(statement);
      }
    }
    for (const fn of [finalize, reaper, learn]) {
      for (const statement of bucketAccess([SPEND_PREFIX], ["s3:GetObject", "s3:PutObject"])) {
        fn.addToRolePolicy(statement);
      }
    }
    // The learner: reads the closed run and the layer, writes versions, counters, log and cached
    // sources, adds its cost line to the run index, and invokes only the configured models.
    for (const statement of [
      ...bucketAccess([LEARNING_PREFIX], ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]),
      ...bucketAccess([RUN_INDEX_PREFIX], ["s3:GetObject", "s3:PutObject"]),
      ...bedrockInvoke([learningConfig.learnerModelId, learningConfig.fallbackModelId]),
    ]) {
      learn.addToRolePolicy(statement);
    }
    for (const fn of [finalize, reaper]) {
      for (const statement of [...bucketAccess(ADMIN_WRITE_PREFIXES, ["s3:PutObject"]), sendMail]) {
        fn.addToRolePolicy(statement);
      }
      this.eventApi.grantPublish(fn);
    }
    for (const statement of [
      new PolicyStatement({
        actions: ["ecs:ListTasks"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": clusterArn } },
      }),
      new PolicyStatement({
        actions: ["ecs:DescribeTasks", "ecs:StopTask"],
        resources: [taskArns],
      }),
      new PolicyStatement({ actions: ["states:ListExecutions"], resources: [stateMachineArn] }),
      new PolicyStatement({
        actions: ["states:DescribeExecution", "states:StopExecution"],
        resources: [executionArn],
      }),
    ]) {
      reaper.addToRolePolicy(statement);
    }
    // The safety net: a handful of invocations an hour, nothing running between them.
    new Rule(this, "ReaperSchedule", {
      description: "Stops agent tasks and executions that outlived their run",
      schedule: Schedule.rate(Duration.minutes(runtimeConfig.reaper.intervalMinutes)),
      targets: [new LambdaFunction(reaper)],
    });

    // Auth feedback ---------------------------------------------------------------------------

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

    // HTTP API routes ------------------------------------------------------------------------

    this.httpApi.addRoutes({
      path: "/api/{proxy+}",
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration("ApiIntegration", apiFunction),
    });
    // More specific than /api/{proxy+}: agent tasks sign these calls with their task role (IAM).
    this.httpApi.addRoutes({
      path: "/api/internal/{proxy+}",
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration("InternalIntegration", internalFunction),
      authorizer: new HttpIamAuthorizer(),
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
      "Scoped to this stack's functions; wildcards are limited to the data prefixes, SES identities, run tasks, executions and live-channel namespaces the functions need.";
    const eventApiLogicalId = this.getLogicalId(this.eventApi.node.defaultChild as CfnElement);
    const functions = [
      apiFunction,
      feedbackFunction,
      internalFunction,
      streamAuthFunction,
      prepare,
      finalize,
      reaper,
      learn,
    ];
    for (const fn of functions) {
      Validations.of(fn).acknowledge({
        id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
        reason: "Standard Lambda logging role; the function logs to its own 30-day log group.",
      });
      for (const id of [
        "AwsSolutions-IAM5[Resource::*]",
        ...[
          ...API_PREFIXES,
          ...ADMIN_WRITE_PREFIXES,
          POOL_PREFIX,
          LEARNING_PREFIX,
          RUN_INDEX_PREFIX,
          SPEND_PREFIX,
          ...OPS_READ_PREFIXES,
        ].map((p) => `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${bucketName}/${p}/*]`),
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ses:${this.region}:${this.account}:identity/*]`,
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:ecs:${this.region}:${this.account}:task/${RUN_CLUSTER}/*]`,
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:states:${this.region}:${this.account}:execution:${RUN_STATE_MACHINE}:*]`,
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:appsync:${this.region}:${this.account}:apis/<${eventApiLogicalId}.ApiId>/channelNamespace/*]`,
      ]) {
        Validations.of(fn).acknowledge({ id, reason });
      }
    }
    for (const id of [learningConfig.learnerModelId, learningConfig.fallbackModelId]) {
      Validations.of(learn).acknowledge({
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock:*::foundation-model/${id.replace(/^[a-z]+\./, "")}]`,
        reason:
          "An au. inference profile routes to the model in either Australian region, so the foundation model ARN needs a region wildcard; it is usable only through the profile (condition).",
      });
    }
    Validations.of(this.httpApi).acknowledge({
      id: "AwsSolutions-APIG4",
      reason:
        "Authentication is done by the application (OTP + signed session cookies); /api/auth/* must be public. /api/internal/* uses IAM.",
    });
    Validations.of(stage).acknowledge({
      id: "AwsSolutions-APIG1",
      reason: "Access logging is enabled via the CfnStage override.",
    });
  }
}
