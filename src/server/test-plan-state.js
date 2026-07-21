const REPLACEABLE_PLAN_STATES = new Set([
  "executed-needs-oracle",
  "not-verified",
  "invalid-test",
  "rejected",
  "timed-out",
]);

export function effectiveTestPlans(job) {
  return allTestPlans(job).filter((plan) => !plan.supersededBy);
}

export function supersedeCorrectedTestPlans(job) {
  const plans = allTestPlans(job);
  const history = new Map((job.operationLoop?.history || []).map((item) => [item.id, item]));
  for (let currentIndex = 0; currentIndex < plans.length; currentIndex += 1) {
    const current = plans[currentIndex];
    if (current.supersededBy || !isSupportedResult(current)) continue;
    for (let priorIndex = 0; priorIndex < currentIndex; priorIndex += 1) {
      const prior = plans[priorIndex];
      if (prior.supersededBy || !isReplaceableGap(prior) || !sameAttemptLineage(prior, current, history)) continue;
      prior.supersededBy = current.id;
      prior.supersededAtEvidenceRevision = Number(job.evidenceRevision || 0);
    }
  }
  return effectiveTestPlans(job);
}

function allTestPlans(job) {
  return Array.isArray(job.ai?.result?.testPlans) ? job.ai.result.testPlans : [];
}

function isSupportedResult(plan) {
  return plan.executionStatus === "executed-ai-supported"
    || (plan.executionStatus === "failed" && plan.failureKind === "property-failure");
}

function isReplaceableGap(plan) {
  return REPLACEABLE_PLAN_STATES.has(plan.executionStatus)
    || (plan.executionStatus === "failed" && plan.failureKind !== "property-failure");
}

function sameAttemptLineage(left, right, history) {
  const leftDigest = planSpecDigest(left, history);
  const rightDigest = planSpecDigest(right, history);
  if (leftDigest && rightDigest) return leftDigest === rightDigest;
  const leftQuestions = [...new Set(left.questionIds || [])].sort();
  const rightQuestions = [...new Set(right.questionIds || [])].sort();
  return leftQuestions.length > 0
    && leftQuestions.length === rightQuestions.length
    && leftQuestions.every((id, index) => id === rightQuestions[index]);
}

function planSpecDigest(plan, history) {
  return plan.operationSpecDigest || history.get(plan.followupOperationId)?.specDigest || null;
}
