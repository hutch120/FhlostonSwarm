import { Stack, type StackProps, Token } from "aws-cdk-lib";
import {
  CaaRecord,
  CaaTag,
  HostedZone,
  MxRecord,
  TxtRecord,
  type IHostedZone,
} from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import type { SwarmConfig } from "../config.js";

export interface DnsStackProps extends StackProps {
  config: SwarmConfig;
}

/**
 * Looks up the existing public hosted zone (created by Route 53 domain registration, never
 * created or deleted here). Other stacks add their own records to it.
 */
export class DnsStack extends Stack {
  readonly zone: IHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.zone = HostedZone.fromLookup(this, "Zone", { domainName: config.domainName });

    // Context lookups return a dummy zone until the real one is cached.
    const zoneId = this.zone.hostedZoneId;
    if (!Token.isUnresolved(zoneId) && zoneId !== "DUMMY" && zoneId !== config.hostedZoneId) {
      throw new Error(
        `Hosted zone lookup for ${config.domainName} returned ${zoneId}, expected ${config.hostedZoneId}`,
      );
    }

    // Only ACM issues certificates for this domain. Also keeps the stack non-empty when the
    // Workspace records are not managed here (CloudFormation rejects empty templates).
    new CaaRecord(this, "Caa", {
      zone: this.zone,
      values: ["amazon.com", "amazontrust.com", "awstrust.com", "amazonaws.com"].map((value) => ({
        flag: 0,
        tag: CaaTag.ISSUE,
        value,
      })),
    });

    // Opt-in: the live Workspace records were created by hand (PREREQUISITES.md section 5).
    // Delete them from the zone before enabling this, or CloudFormation will refuse to create them.
    const google = config.googleWorkspace;
    if (google) {
      new MxRecord(this, "GoogleMx", {
        zone: this.zone,
        values: google.mx.map((m) => ({ priority: m.priority, hostName: m.host })),
      });
      new TxtRecord(this, "ApexTxt", {
        zone: this.zone,
        values: [google.spf, google.siteVerification],
      });
      new TxtRecord(this, "GoogleDkim", {
        zone: this.zone,
        recordName: "google._domainkey",
        values: [google.dkim],
      });
    }
  }
}
