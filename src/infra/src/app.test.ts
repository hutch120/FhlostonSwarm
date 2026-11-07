import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig, parseConfig, type SwarmConfig } from "./config.js";

const outdirs: string[] = [];

function synth(overrides: Partial<SwarmConfig> = {}) {
  const outdir = mkdtempSync(join(tmpdir(), "swarm-infra-"));
  outdirs.push(outdir);
  const app = buildApp({ ...loadConfig(), ...overrides }, new App({ outdir }));
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
      "SwarmData",
      "SwarmDns",
      "SwarmEdge",
      "SwarmOps",
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
            ContentSecurityPolicy: Match.stringLikeRegexp("frame-ancestors 'none'"),
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

  it("only attaches the apex domain once the us-east-1 certificate is configured", () => {
    template("SwarmEdge").resourceCountIs("AWS::Route53::RecordSet", 0);

    const withCert = synth({
      cloudfrontCertificateArn:
        "arn:aws:acm:us-east-1:885922397779:certificate/00000000-0000-0000-0000-000000000000",
    }).template("SwarmEdge");
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
      "AWS::EC2::VPC",
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
    }
  });
});
