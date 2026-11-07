import { Stack, type StackProps } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import type { Construct } from "constructs";
import type { SwarmConfig } from "../config.js";

export interface OpsStackProps extends StackProps {
  config: SwarmConfig;
}

/** Cost guardrails: monthly budget alert (the idle-spend tripwire). */
export class OpsStack extends Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);
    const { config } = props;

    const subscribers = [{ subscriptionType: "EMAIL", address: config.alertEmail }];
    new CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "swarm-monthly-idle",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: config.idleBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers,
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers,
        },
      ],
    });
  }
}
