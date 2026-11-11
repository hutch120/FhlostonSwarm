import { fileURLToPath } from "node:url";
import { runtimeConfig, tierLimits } from "@swarm/shared/server";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  Validations,
  type StackProps,
} from "aws-cdk-lib";
import { IpAddresses, Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
  Capability,
  Cluster,
  ContainerDependencyCondition,
  ContainerImage,
  CpuArchitecture,
  FargatePlatformVersion,
  FargateTaskDefinition,
  LinuxParameters,
  LogDriver,
  OperatingSystemFamily,
  type ContainerDefinition,
} from "aws-cdk-lib/aws-ecs";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Choice,
  Condition,
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  StateMachine,
  Succeed,
  Timeout,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  EcsFargateLaunchTarget,
  EcsRunTask,
  LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import type { SwarmConfig } from "../config.js";
import {
  AGENT_FAMILY,
  RUN_CLUSTER,
  RUN_STATE_MACHINE,
  SYNTHETIC_TARGET_FAMILY,
  SYNTHETIC_TARGET_PORT,
} from "../names.js";

export interface RunsStackProps extends StackProps {
  config: SwarmConfig;
  internalInvokeArn: string;
  prepareFunction: IFunction;
  finalizeFunction: IFunction;
}

const AGENTS_DIR = fileURLToPath(new URL("../../../agents/", import.meta.url));
const SYNTHETIC_DIR = fileURLToPath(new URL("../../../synthetic-target/", import.meta.url));

/**
 * Where runs execute: a network with public subnets only (no NAT, no endpoints), the ECS cluster,
 * the agent task (agent container plus the scope-proxy sidecar) and the Step Functions state machine
 * that drives a run. Nothing here runs between scans: the cluster has no services, tasks exist only
 * while a run does. Also the on-demand synthetic target (task definition only; started by `swarm
 * synthetic-target start`).
 */
export class RunsStack extends Stack {
  readonly vpc: Vpc;
  readonly cluster: Cluster;
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: RunsStackProps) {
    super(scope, id, props);

    // Network --------------------------------------------------------------------------------

    this.vpc = new Vpc(this, "Vpc", {
      ipAddresses: IpAddresses.cidr("10.20.0.0/16"),
      maxAzs: 2,
      // Tasks get a public IP and reach the internet through the free internet gateway.
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
      // Nothing uses the default security group, and restricting it would add a custom-resource
      // Lambda whose log group has no retention.
      restrictDefaultSecurityGroup: false,
    });
    Validations.of(this.vpc).acknowledge({
      id: "AwsSolutions-VPC7",
      reason:
        "Flow logs would add per-GB log cost for a network that only exists while a run does; the scope proxy logs every request as evidence.",
    });

    this.cluster = new Cluster(this, "Cluster", {
      clusterName: RUN_CLUSTER,
      vpc: this.vpc,
      enableFargateCapacityProviders: false,
    });
    Validations.of(this.cluster).acknowledge({
      id: "AwsSolutions-ECS4",
      reason:
        "Container Insights bills per metric; tasks are short-lived and log to CloudWatch Logs.",
    });

    // The agent task --------------------------------------------------------------------------

    const agentSecurityGroup = new SecurityGroup(this, "AgentSecurityGroup", {
      vpc: this.vpc,
      description: "Agent tasks: no inbound, outbound for the target, the API and image pulls",
      allowAllOutbound: true,
    });

    const taskRole = new Role(this, "AgentTaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      description:
        "Agent tasks: may call the internal API and invoke the configured Bedrock models (no S3)",
    });
    taskRole.addToPolicy(
      new PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [props.internalInvokeArn],
      }),
    );
    // The `au.` inference profiles run in ap-southeast-2 and ap-southeast-4, so the underlying
    // foundation model is allowed in any region, but only when reached through the profile.
    const profileIds = [...new Set(Object.values(tierLimits).map((l) => l.modelId))];
    taskRole.addToPolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: profileIds.map(
          (id) =>
            `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${id}`,
        ),
      }),
    );
    taskRole.addToPolicy(
      new PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: profileIds.map(
          (id) =>
            `arn:${this.partition}:bedrock:*::foundation-model/${id.replace(/^[a-z]+\./, "")}`,
        ),
        conditions: {
          StringLike: {
            "bedrock:InferenceProfileArn": profileIds.map(
              (id) =>
                `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${id}`,
            ),
          },
        },
      }),
    );
    for (const id of profileIds) {
      Validations.of(taskRole).acknowledge({
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:bedrock:*::foundation-model/${id.replace(/^[a-z]+\./, "")}]`,
        reason:
          "An au. inference profile routes to the model in either Australian region, so the foundation model ARN needs a region wildcard; it is usable only through the profile (condition).",
      });
    }
    Validations.of(taskRole).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:execute-api:${this.region}:${this.account}:SwarmApi:ExportsOutputRefHttpApiF5A9A8A7F70B5BDD/*/*/api/internal/*]`,
      reason:
        "The role may call only the internal API's routes; the API id is the only fixed part.",
    });

    const agentLogs = new LogGroup(this, "AgentLogs", {
      logGroupName: "/swarm/agent",
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const image = ContainerImage.fromDockerImageAsset(
      new DockerImageAsset(this, "AgentImage", {
        directory: AGENTS_DIR,
        platform: Platform.LINUX_AMD64,
      }),
    );

    const { vcpu, memoryGb } = runtimeConfig.agentTask;
    const agentTask = new FargateTaskDefinition(this, "AgentTask", {
      family: AGENT_FAMILY,
      cpu: vcpu * 1024,
      memoryLimitMiB: memoryGb * 1024,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.X86_64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    const containerCommon = {
      image,
      readonlyRootFilesystem: true,
      logging: LogDriver.awsLogs({ logGroup: agentLogs, streamPrefix: "run" }),
      environment: { AWS_REGION: this.region },
    };
    const agentLinux = new LinuxParameters(this, "AgentLinuxParameters");
    agentLinux.dropCapabilities(Capability.ALL);
    const proxy = agentTask.addContainer("proxy", {
      ...containerCommon,
      command: ["node", "proxy.mjs"],
      // The task ends when the agent does; the proxy gets SIGTERM and posts its log first.
      essential: false,
      stopTimeout: Duration.seconds(30),
    });
    const agent = agentTask.addContainer("agent", {
      ...containerCommon,
      command: ["node", "task.mjs"],
      essential: true,
      // The browser parses hostile pages: no Linux capabilities and a non-root user. Its profile
      // goes to /tmp in the container's own ephemeral layer; a Fargate scratch volume is root-owned
      // and the user cannot write to it, so the root filesystem is not read-only for this container.
      readonlyRootFilesystem: false,
      linuxParameters: agentLinux,
      environment: { ...containerCommon.environment, HOME: "/tmp", TMPDIR: "/tmp" },
    });
    agent.addContainerDependencies({
      container: proxy,
      condition: ContainerDependencyCondition.START,
    });

    // The state machine -----------------------------------------------------------------------

    const prepare = new LambdaInvoke(this, "Prepare", {
      lambdaFunction: props.prepareFunction,
      payloadResponseOnly: true,
      resultPath: "$.prepared",
    });
    const finalize = new LambdaInvoke(this, "Finalize", {
      lambdaFunction: props.finalizeFunction,
      // No payload: the function receives the whole state (owner, run id, task times if a task ran,
      // and the error if something failed).
      payloadResponseOnly: true,
      resultPath: JsonPath.DISCARD,
    });

    const env = (name: string, value: string) => ({ name, value });
    const runEnvironment = [
      env("SWARM_API_BASE", JsonPath.stringAt("$.prepared.apiBase")),
      env("SWARM_OWNER", JsonPath.stringAt("$.owner")),
      env("SWARM_RUN_ID", JsonPath.stringAt("$.runId")),
      env("SWARM_RUN_TOKEN", JsonPath.stringAt("$.prepared.token")),
      env("SWARM_MAX_SECONDS", JsonPath.format("{}", JsonPath.stringAt("$.prepared.maxSeconds"))),
    ];
    const asOverride = (container: ContainerDefinition) => ({
      containerDefinition: container,
      environment: runEnvironment,
    });
    const runAgent = new EcsRunTask(this, "RunAgent", {
      integrationPattern: IntegrationPattern.RUN_JOB,
      cluster: this.cluster,
      taskDefinition: agentTask,
      launchTarget: new EcsFargateLaunchTarget({ platformVersion: FargatePlatformVersion.LATEST }),
      assignPublicIp: true,
      subnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [agentSecurityGroup],
      containerOverrides: [asOverride(agent), asOverride(proxy)],
      taskTimeout: Timeout.at("$.prepared.maxSeconds"),
      resultSelector: {
        pullStartedAt: JsonPath.stringAt("$.PullStartedAt"),
        startedAt: JsonPath.stringAt("$.StartedAt"),
        stoppedAt: JsonPath.stringAt("$.StoppedAt"),
      },
      resultPath: "$.task",
    });

    // Any failure still closes the run (partial report, credit returned), and a stopped run takes the same path.
    prepare.addCatch(finalize, { resultPath: "$.error" });
    runAgent.addCatch(finalize, { resultPath: "$.error" });
    // A run whose depth pool is full waits here (the run stays queued), looking again every few seconds.
    const waitForSlot = new Wait(this, "WaitForSlot", {
      time: WaitTime.duration(Duration.seconds(runtimeConfig.pool.pollSeconds)),
    });
    waitForSlot.next(prepare);
    const slotFree = new Choice(this, "SlotFree")
      .when(Condition.booleanEquals("$.prepared.waiting", true), waitForSlot)
      .otherwise(runAgent);
    prepare.next(slotFree);
    runAgent.next(finalize);

    // The PDF of the closed run's report: the same image, a different entrypoint. Best effort: a
    // failure here never changes the run, and the HTML and JSON reports are already in place.
    const renderPdf = new EcsRunTask(this, "RenderPdf", {
      integrationPattern: IntegrationPattern.RUN_JOB,
      cluster: this.cluster,
      taskDefinition: agentTask,
      launchTarget: new EcsFargateLaunchTarget({ platformVersion: FargatePlatformVersion.LATEST }),
      assignPublicIp: true,
      subnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [agentSecurityGroup],
      containerOverrides: [
        { ...asOverride(agent), command: ["node", "pdf.mjs"] },
        // The scope proxy has nothing to do here: it exits at once.
        { ...asOverride(proxy), command: ["node", "-e", "0"] },
      ],
      taskTimeout: Timeout.duration(Duration.minutes(5)),
      resultPath: JsonPath.DISCARD,
    });
    const done = new Succeed(this, "Done");
    renderPdf.addCatch(done, { resultPath: JsonPath.DISCARD });
    renderPdf.next(done);
    // A run that never got a token never ran a task (declined in the queue, or failed to prepare).
    finalize.next(
      new Choice(this, "ReportReady")
        .when(Condition.isPresent("$.prepared.token"), renderPdf)
        .otherwise(done),
    );

    const stateLogs = new LogGroup(this, "StateMachineLogs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.stateMachine = new StateMachine(this, "RunStateMachine", {
      stateMachineName: RUN_STATE_MACHINE,
      definitionBody: DefinitionBody.fromChainable(prepare),
      // The hard ceiling; each agent task also has its own timeout from the tier.
      timeout: Duration.hours(2),
      logs: {
        destination: stateLogs,
        level: LogLevel.ERROR,
        // Execution data carries run tokens and target details, so it stays out of the logs.
        includeExecutionData: false,
      },
    });
    Validations.of(this.stateMachine).acknowledge({
      id: "AwsSolutions-SF1",
      reason:
        "Only errors are logged: execution data holds run tokens and target details and must not reach CloudWatch Logs.",
    });
    Validations.of(this.stateMachine).acknowledge({
      id: "AwsSolutions-SF2",
      reason: "X-Ray tracing would add cost for little value on a four-step workflow.",
    });
    for (const id of [
      "AwsSolutions-IAM5[Resource::*]",
      "AwsSolutions-IAM5[Resource::SwarmApi:ExportsOutputFnGetAttFinalizeFunction2E2E0FC2Arn7153F5BA:*]",
      "AwsSolutions-IAM5[Resource::SwarmApi:ExportsOutputFnGetAttPrepareFunction8FAA640BArn81F3460A:*]",
      'AwsSolutions-IAM5[Resource::arn:{"Fn::Select":[1,{"Fn::Split":[":",{"Ref":"AgentTask285670E7"}]}]}:{"Fn::Select":[2,{"Fn::Split":[":",{"Ref":"AgentTask285670E7"}]}]}:{"Fn::Select":[3,{"Fn::Split":[":",{"Ref":"AgentTask285670E7"}]}]}:{"Fn::Select":[4,{"Fn::Split":[":",{"Ref":"AgentTask285670E7"}]}]}:{"Fn::Select":[0,{"Fn::Split":["/",{"Fn::Select":[5,{"Fn::Split":[":",{"Ref":"AgentTask285670E7"}]}]}]}]}/{"Fn::Select":[1,{"Fn::Split":["/",{"Fn::Select":[5,{"Fn::Split":[":",{"Ref":"AgentTask285670E7"}]}]}]}]}:*]',
    ]) {
      Validations.of(this.stateMachine).acknowledge({
        id,
        reason:
          "Generated by the Step Functions task constructs: scoped to this cluster's tasks and to the two run functions (their versions).",
      });
    }
    for (const role of [agentTask.obtainExecutionRole()]) {
      Validations.of(role).acknowledge({
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "ecr:GetAuthorizationToken has no resource-level scope; the rest of the role is limited to its own image repository and log group.",
      });
    }

    // The synthetic target (on demand) ----------------------------------------------------------

    const targetSecurityGroup = new SecurityGroup(this, "SyntheticTargetSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: SYNTHETIC_TARGET_FAMILY,
      description: "Synthetic target: one port, open while a test run needs it",
      allowAllOutbound: true,
    });
    targetSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(SYNTHETIC_TARGET_PORT),
      "The synthetic target (a deliberately vulnerable test app, started on demand)",
    );
    Validations.of(targetSecurityGroup).acknowledge({
      id: "AwsSolutions-EC23",
      reason:
        "The synthetic target must be reachable by the agent tasks, whose public addresses are not fixed. It holds only fake data and is stopped after each use.",
    });

    const targetLogs = new LogGroup(this, "SyntheticTargetLogs", {
      logGroupName: "/swarm/synthetic-target",
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const targetTask = new FargateTaskDefinition(this, "SyntheticTargetTask", {
      family: SYNTHETIC_TARGET_FAMILY,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.X86_64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    targetTask.addContainer("target", {
      image: ContainerImage.fromDockerImageAsset(
        new DockerImageAsset(this, "SyntheticTargetImage", {
          directory: SYNTHETIC_DIR,
          platform: Platform.LINUX_AMD64,
        }),
      ),
      portMappings: [{ containerPort: SYNTHETIC_TARGET_PORT }],
      readonlyRootFilesystem: true,
      logging: LogDriver.awsLogs({ logGroup: targetLogs, streamPrefix: "target" }),
    });
    // Test infrastructure: named swarm-test-* and tagged so `swarm test-cleanup` recognises it.
    for (const resource of [targetTask, targetSecurityGroup]) {
      Tags.of(resource).add("swarm:test", "true", { priority: 300 });
    }
    Validations.of(targetTask.obtainExecutionRole()).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "ecr:GetAuthorizationToken has no resource-level scope; the rest of the role is limited to its own image repository and log group.",
    });
    Validations.of(targetTask).acknowledge({
      id: "AwsSolutions-ECS2",
      reason: "The only environment is the port, set in the image; there are no secrets.",
    });
    for (const fn of [agentTask]) {
      Validations.of(fn).acknowledge({
        id: "AwsSolutions-ECS2",
        reason:
          "Run-specific values (and the run token) are injected per task by the state machine, not baked into the definition.",
      });
    }

    new CfnOutput(this, "SyntheticTargetSubnets", {
      value: this.vpc.publicSubnets.map((s) => s.subnetId).join(","),
    });
    new CfnOutput(this, "SyntheticTargetSecurityGroupId", {
      value: targetSecurityGroup.securityGroupId,
    });
  }
}
