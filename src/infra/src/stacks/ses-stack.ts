import { Stack, type StackProps } from "aws-cdk-lib";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { type IHostedZone, TxtRecord } from "aws-cdk-lib/aws-route53";
import {
  ConfigurationSet,
  ConfigurationSetTlsPolicy,
  EmailIdentity,
  EventDestination,
  EmailSendingEvent,
  Identity,
  MailFromBehaviorOnMxFailure,
} from "aws-cdk-lib/aws-ses";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Validations } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { SwarmConfig } from "../config.js";

export interface SesStackProps extends StackProps {
  config: SwarmConfig;
  zone: IHostedZone;
}

/** SES domain identity with Easy DKIM + custom MAIL FROM, DMARC and bounce/complaint events. */
export class SesStack extends Stack {
  readonly identity: EmailIdentity;
  readonly configurationSet: ConfigurationSet;
  readonly feedbackTopic: Topic;

  constructor(scope: Construct, id: string, props: SesStackProps) {
    super(scope, id, props);
    const { config, zone } = props;

    this.feedbackTopic = new Topic(this, "FeedbackTopic", {
      topicName: "swarm-ses-feedback",
      enforceSSL: true,
    });
    this.feedbackTopic.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("ses.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.feedbackTopic.topicArn],
        conditions: { StringEquals: { "AWS:SourceAccount": config.account } },
      }),
    );

    this.configurationSet = new ConfigurationSet(this, "ConfigurationSet", {
      configurationSetName: "swarm-default",
      reputationMetrics: true,
      tlsPolicy: ConfigurationSetTlsPolicy.REQUIRE,
    });
    this.configurationSet.addEventDestination("BounceComplaint", {
      destination: EventDestination.snsTopic(this.feedbackTopic),
      events: [EmailSendingEvent.BOUNCE, EmailSendingEvent.COMPLAINT, EmailSendingEvent.REJECT],
    });

    // Creates the three DKIM CNAMEs and the bounce. MX/SPF records in the hosted zone.
    this.identity = new EmailIdentity(this, "Identity", {
      identity: Identity.publicHostedZone(zone),
      configurationSet: this.configurationSet,
      dkimSigning: true,
      feedbackForwarding: false,
      mailFromDomain: `bounce.${config.domainName}`,
      mailFromBehaviorOnMxFailure: MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    });

    // Shared with Google Workspace mail; tighten the policy once both senders align.
    new TxtRecord(this, "Dmarc", {
      zone,
      recordName: "_dmarc",
      values: [`v=DMARC1; p=${config.dmarc.policy}; rua=mailto:${config.dmarc.reportEmail}`],
    });

    Validations.of(this.feedbackTopic).acknowledge({
      id: "AwsSolutions-SNS2",
      reason:
        "A customer-managed KMS key bills 24/7 (PLAN.md idle-cost rules) and SES cannot publish to a topic encrypted with the AWS-managed key. The topic carries bounce/complaint metadata only.",
    });
  }
}
