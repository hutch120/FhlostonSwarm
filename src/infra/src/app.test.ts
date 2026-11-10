import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, it } from "vitest";
import { lambdaEnvSchemas } from "../../api/src/env.js";
import { buildApp } from "./app.js";
import { loadConfig, parseConfig, type SwarmConfig } from "./config.js";

const outdirs: string[] = [];

function synth(overrides: Partial<SwarmConfig> = {}) {
  const outdir = mkdtempSync(join(tmpdir(), "swarm-infra-"));
  outdirs.push(outdir);
  const app = buildApp(
    { ...loadConfig(), ...overrides },
    new App({ outdir, context: { "aws:cdk:bundling-stacks": [] } }),
  );
  const assembly = app.synth();
  const template = (name: string) => Template.fromJSON(assembly.getStackByName(name).template);
  return { assembly, template };
}

afterAll(() => {
  for (const dir of outdirs) rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("parses the committed config", () => {
    const config = loadConfig();
    expect(config.account).toBe("885922397779");
    expect(config.region).toBe("ap-southeast-2");
  });

  it("rejects a certificate outside us-east-1", () => {
    expect(() =>
      parseConfig({
        ...loadConfig(),
        cloudfrontCertificateArn: "arn:aws:acm:ap-southeast-2:885922397779:certificate/abc",
      }),
    ).toThrow();
  });
});

describe("infrastructure app", () => {
  const { assembly, template } = synth();

  it("defines the expected single-environment stacks with no stage prefixes", () => {
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual([
      "SwarmApi",
      "SwarmData",
      "SwarmDns",
      "SwarmEdge",
      "SwarmOps",
      "SwarmRuns",
      "SwarmSes",
    ]);
    for (const stack of assembly.stacks) {
      expect(stack.environment.account).toBe("885922397779");
      expect(stack.environment.region).toBe("ap-southeast-2");
    }
  });

  it("data bucket is private, encrypted, unversioned, TLS-only and retained", () => {
    const t = template("SwarmData");
    t.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        BucketName: "swarm-data-885922397779",
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
            Match.objectLike({ Prefix: "_test/", ExpirationInDays: 1, Status: "Enabled" }),
          ]),
        },
      },
    });
    const bucket = Object.values(t.findResources("AWS::S3::Bucket"))[0]!;
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
    t.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("edge serves HTTPS with HSTS and CSP headers from a private bucket via OAC", () => {
    const t = template("SwarmEdge");
    t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          StrictTransportSecurity: Match.objectLike({ Override: true, IncludeSubdomains: true }),
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp(
              "connect-src 'self' wss://\\*\\.appsync-realtime-api\\.ap-southeast-2\\.amazonaws\\.com.*frame-ancestors 'none'",
            ),
          }),
        },
      },
    });
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      }),
    });
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  });

  it("attaches the apex domain only when the us-east-1 certificate is configured", () => {
    synth({ cloudfrontCertificateArn: null })
      .template("SwarmEdge")
      .resourceCountIs("AWS::Route53::RecordSet", 0);

    const withCert = template("SwarmEdge");
    withCert.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ Aliases: ["fhlostonswarm.com"] }),
    });
    withCert.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "A",
      Name: "fhlostonswarm.com.",
    });
    withCert.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "AAAA",
      Name: "fhlostonswarm.com.",
    });
  });

  it("DNS stack looks up the zone and only manages Google Workspace records when configured", () => {
    const base = template("SwarmDns");
    base.resourceCountIs("AWS::Route53::HostedZone", 0);
    base.resourceCountIs("AWS::Route53::RecordSet", 1);
    base.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "CAA",
      Name: "fhlostonswarm.com.",
    });

    const withGoogle = synth({
      googleWorkspace: {
        mx: [{ priority: 1, host: "smtp.google.com." }],
        spf: "v=spf1 include:_spf.google.com ~all",
        siteVerification: "google-site-verification=test",
        dkim: "v=DKIM1; k=rsa; p=test",
      },
    }).template("SwarmDns");
    withGoogle.hasResourceProperties("AWS::Route53::RecordSet", { Type: "MX" });
    withGoogle.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: "google._domainkey.fhlostonswarm.com.",
    });
    withGoogle.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: "fhlostonswarm.com.",
    });
  });

  it("SES has DKIM, custom MAIL FROM, DMARC and a bounce/complaint destination", () => {
    const t = template("SwarmSes");
    t.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "fhlostonswarm.com",
      DkimAttributes: { SigningEnabled: true },
      MailFromAttributes: Match.objectLike({ MailFromDomain: "bounce.fhlostonswarm.com" }),
    });
    t.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "TXT",
      Name: "_dmarc.fhlostonswarm.com.",
      ResourceRecords: [Match.stringLikeRegexp("v=DMARC1; p=none")],
    });
    t.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: Match.objectLike({
        Enabled: true,
        MatchingEventTypes: ["bounce", "complaint", "reject"],
      }),
    });
  });

  it("API: Hono Lambda behind a throttled HTTP API, scoped IAM, 30-day logs", () => {
    const t = template("SwarmApi");
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({
          DATA_BUCKET: "swarm-data-885922397779",
          SITE_ORIGIN: "https://fhlostonswarm.com",
          PEPPER_PARAMETER: "/swarm/auth/pepper",
          MAIL_FROM: "login@fhlostonswarm.com",
        }),
      },
    });
    t.resourceCountIs("AWS::Lambda::Function", 7);
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /api/{proxy+}" });
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda" });

    const statements = Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
      (p) =>
        p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[],
    );
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toContain("s3:PutObject");
    expect(actions).toContain("ssm:GetParameters");
    expect(actions.filter((a) => a === "*" || a.endsWith(":*"))).toEqual([]);
    // Nothing outside the data prefixes, and no test data.
    const resources = JSON.stringify(statements.map((s) => s.Resource));
    expect(resources).not.toContain("_test");
  });

  it("API: the agent routes need IAM, the live channel is read-only for browsers", () => {
    const t = template("SwarmApi");
    const routes = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => r.Properties as { RouteKey: string; AuthorizationType?: string },
    );
    expect(routes.find((r) => r.RouteKey === "ANY /api/internal/{proxy+}")?.AuthorizationType).toBe(
      "AWS_IAM",
    );
    expect(routes.find((r) => r.RouteKey === "ANY /api/{proxy+}")?.AuthorizationType).toBe("NONE");

    t.hasResourceProperties("AWS::AppSync::Api", {
      Name: "swarm-events",
      EventConfig: Match.objectLike({
        AuthProviders: Match.arrayWith([
          Match.objectLike({ AuthType: "AWS_LAMBDA" }),
          Match.objectLike({ AuthType: "AWS_IAM" }),
        ]),
        ConnectionAuthModes: [{ AuthType: "AWS_LAMBDA" }],
        DefaultPublishAuthModes: [{ AuthType: "AWS_IAM" }],
        DefaultSubscribeAuthModes: [{ AuthType: "AWS_LAMBDA" }],
      }),
    });
    t.hasResourceProperties("AWS::AppSync::ChannelNamespace", { Name: "runs" });
  });

  it("API: the reaper runs on a short schedule and the run functions exist", () => {
    const t = template("SwarmApi");
    t.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
    for (const handler of ["prepare", "finalize", "reaper"]) {
      t.hasResourceProperties("AWS::Lambda::Function", { Handler: `index.${handler}` });
    }
  });

  it("API: every function is deployed with every variable it reads at start-up", () => {
    const t = template("SwarmApi");
    const functions = Object.values(t.findResources("AWS::Lambda::Function")).map((f) => ({
      description: String(f.Properties.Description ?? ""),
      handler: String(f.Properties.Handler),
      variables: Object.keys(
        (f.Properties.Environment?.Variables ?? {}) as Record<string, unknown>,
      ),
    }));
    const required = (schema: { shape: Record<string, { isOptional(): boolean }> }) =>
      Object.entries(schema.shape)
        // AWS_REGION is set by Lambda itself.
        .filter(([key, field]) => key !== "AWS_REGION" && !field.isOptional())
        .map(([key]) => key);
    const expectations: [string, string[]][] = [
      ["Swarm API (Hono)", required(lambdaEnvSchemas.api)],
      ["Agent task API", required(lambdaEnvSchemas.internal)],
      ["Authorizes browsers", required(lambdaEnvSchemas.streamAuth)],
      ["Run step 1", required(lambdaEnvSchemas.orchestrator)],
      ["Run last step", required(lambdaEnvSchemas.orchestrator)],
      ["Stops tasks and executions", required(lambdaEnvSchemas.orchestrator)],
    ];
    for (const [description, keys] of expectations) {
      const fn = functions.find((f) => f.description.startsWith(description));
      expect(fn, description).toBeDefined();
      expect(fn!.variables, description).toEqual(expect.arrayContaining(keys));
    }
  });

  it("edge routes /api/* to the API uncached, and SPA fallback does not rewrite API errors", () => {
    const t = template("SwarmEdge");
    const [distribution] = Object.values(t.findResources("AWS::CloudFront::Distribution"));
    const config = distribution!.Properties.DistributionConfig;
    expect(config.CustomErrorResponses).toBeUndefined();
    expect(config.CacheBehaviors).toHaveLength(1);
    expect(config.CacheBehaviors[0]).toMatchObject({
      PathPattern: "/api/*",
      ViewerProtocolPolicy: "https-only",
      AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
    });
    expect(config.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
    t.hasResourceProperties("AWS::CloudFront::OriginRequestPolicy", {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: {
          HeaderBehavior: "whitelist",
          Headers: ["Origin", "CloudFront-Viewer-Address", "X-CSRF-Token"],
        },
        CookiesConfig: { CookieBehavior: "all" },
      }),
    });
  });

  it("data bucket expires abandoned OTP challenges, confirmation links and rate-limit counters", () => {
    template("SwarmData").hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: "auth/otp/", ExpirationInDays: 1 }),
          Match.objectLike({ Prefix: "auth/ratelimit/", ExpirationInDays: 2 }),
          Match.objectLike({ Prefix: "auth/notify-confirm/", ExpirationInDays: 3 }),
        ]),
      },
    });
  });

  it("ops defines the idle-spend budget alert", () => {
    template("SwarmOps").hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: "USD" } }),
    });
  });

  it("every log group has 30-day retention and every Lambda logs to one", () => {
    for (const stack of assembly.stacks) {
      const t = Template.fromJSON(stack.template);
      for (const group of Object.values(t.findResources("AWS::Logs::LogGroup"))) {
        expect(group.Properties.RetentionInDays).toBe(30);
      }
      for (const fn of Object.values(t.findResources("AWS::Lambda::Function"))) {
        expect(fn.Properties.LoggingConfig?.LogGroup).toBeDefined();
      }
    }
  });

  it("creates no always-on billable resources", () => {
    const forbidden = [
      "AWS::EC2::NatGateway",
      "AWS::EC2::VPCEndpoint",
      "AWS::EC2::EIP",
      "AWS::KMS::Key",
      "AWS::SecretsManager::Secret",
      "AWS::WAFv2::WebACL",
      "AWS::DynamoDB::Table",
      "AWS::ECS::Service",
    ];
    for (const stack of assembly.stacks) {
      const resources = (stack.template.Resources ?? {}) as Record<string, { Type: string }>;
      const types = new Set(Object.values(resources).map((r) => r.Type));
      for (const type of forbidden)
        expect(types.has(type), `${stack.stackName}: ${type}`).toBe(false);
      // A network is free; it may only exist in the stack that runs tasks.
      if (stack.stackName !== "SwarmRuns") expect(types.has("AWS::EC2::VPC")).toBe(false);
    }
  });

  describe("runs", () => {
    const t = template("SwarmRuns");
    // CloudFormation properties are free-form JSON; the assertions below narrow what they use.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Properties = Record<string, any>;
    const resources = (type: string) =>
      Object.entries(t.findResources(type)).map(([id, r]) => ({
        id,
        Properties: r.Properties as Properties,
      }));

    it("has a cluster with no services, and a network of public subnets only", () => {
      t.hasResourceProperties("AWS::ECS::Cluster", { ClusterName: "swarm-runs" });
      t.resourceCountIs("AWS::EC2::VPC", 1);
      t.resourceCountIs("AWS::EC2::InternetGateway", 1);
      const subnets = resources("AWS::EC2::Subnet");
      expect(subnets.length).toBe(2);
      expect(subnets.every((s) => s.Properties.MapPublicIpOnLaunch === true)).toBe(true);
    });

    it("agent task: the agent and a scope-proxy sidecar, read-only, on a small Fargate size", () => {
      const [task] = resources("AWS::ECS::TaskDefinition").filter(
        (r) => r.Properties.Family === "swarm-agent",
      );
      expect(task!.Properties).toMatchObject({ Cpu: "512", Memory: "1024", NetworkMode: "awsvpc" });
      const containers = task!.Properties.ContainerDefinitions as {
        Name: string;
        Essential?: boolean;
        ReadonlyRootFilesystem: boolean;
        Command: string[];
      }[];
      expect(containers.map((c) => c.Name).sort()).toEqual(["agent", "proxy"]);
      expect(containers.every((c) => c.ReadonlyRootFilesystem)).toBe(true);
      expect(containers.find((c) => c.Name === "agent")?.Essential).toBe(true);
      expect(containers.find((c) => c.Name === "proxy")?.Essential).toBe(false);
      expect(containers.find((c) => c.Name === "proxy")?.Command).toEqual(["node", "proxy.mjs"]);
    });

    it("agent tasks can only call the internal API: no S3, no other AWS service", () => {
      const roleIds = resources("AWS::IAM::Role")
        .filter((r) => r.id.startsWith("AgentTaskRole"))
        .map((r) => r.id);
      expect(roleIds).toHaveLength(1);
      const policies = resources("AWS::IAM::Policy").filter((p) =>
        JSON.stringify(p.Properties.Roles).includes(roleIds[0]!),
      );
      const actions = policies.flatMap((p) =>
        (p.Properties.PolicyDocument.Statement as { Action: string | string[] }[]).flatMap((s) =>
          Array.isArray(s.Action) ? s.Action : [s.Action],
        ),
      );
      expect(actions).toEqual(["execute-api:Invoke"]);
    });

    it("agent tasks accept no inbound traffic", () => {
      const groups = resources("AWS::EC2::SecurityGroup");
      const agent = groups.find((g) => g.id.startsWith("AgentSecurityGroup"))!;
      expect(agent.Properties.SecurityGroupIngress).toBeUndefined();
    });

    it("state machine: prepare, run the task and wait, finalize; any failure still finalizes", () => {
      const [machine] = resources("AWS::StepFunctions::StateMachine");
      expect(machine!.Properties.StateMachineName).toBe("swarm-run");
      const definition = JSON.stringify(machine!.Properties.DefinitionString);
      expect(definition).toContain("ecs:runTask.sync");
      expect(definition).toContain("AssignPublicIp");
      expect(definition).toContain("TimeoutSecondsPath");
      expect(definition).toContain("States.ALL");
      expect(definition).toContain("Finalize");
      t.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        LoggingConfiguration: Match.objectLike({ Level: "ERROR", IncludeExecutionData: false }),
      });
    });

    it("synthetic target: a swarm-test-* task and security group, tagged as test data, one port open", () => {
      const [task] = resources("AWS::ECS::TaskDefinition").filter(
        (r) => r.Properties.Family === "swarm-test-synthetic-target",
      );
      expect(task).toBeDefined();
      expect(task!.Properties.Tags).toEqual(
        expect.arrayContaining([{ Key: "swarm:test", Value: "true" }]),
      );
      const group = resources("AWS::EC2::SecurityGroup").find(
        (g) => g.Properties.GroupName === "swarm-test-synthetic-target",
      )!;
      expect(group.Properties.SecurityGroupIngress).toEqual([
        expect.objectContaining({ FromPort: 8080, ToPort: 8080, CidrIp: "0.0.0.0/0" }),
      ]);
      expect(group.Properties.Tags).toEqual(
        expect.arrayContaining([{ Key: "swarm:test", Value: "true" }]),
      );
    });

    it("permanent infrastructure is not marked as test data", () => {
      const cluster = resources("AWS::ECS::Cluster")[0]!;
      expect(cluster.Properties.Tags).toEqual(
        expect.arrayContaining([{ Key: "swarm:test", Value: "false" }]),
      );
    });
  });
});
