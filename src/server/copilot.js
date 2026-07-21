const MAX_QUESTION_LENGTH = 2_000;

const SECRET_PATTERNS = [
  /\b(?:private[ _-]?key|secret[ _-]?key|seed phrase|mnemonic|recovery phrase)\b\s*(?::|=|is)?\s*(?:0x)?[0-9a-z][0-9a-z,;\s-]{15,}/i,
  /\b(?:api[ _-]?key|access[ _-]?token|password|passwd)\b\s*(?::|=|is)\s*\S+/i,
  /\b(?:authorization\s*:\s*)?bearer\s+\S+/i,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/i,
  /https?:\/\/\S*(?:[?&](?:key|token|api[_-]?key)=)[^&\s]+/i,
  /https?:\/\/\S*\/(?:api[_-]?key|token|secret|credential)s?\/[^\s/?#]+/i,
  /https?:\/\/\S+/i,
  /\b(?:sk|xox[baprs])-[A-Za-z0-9_-]{16,}\b/i,
  /\b(?:0x)?[0-9a-f]{64}\b/i,
];

export function normalizeCopilotQuestion(question) {
  if (typeof question !== "string" || !question.trim()) throw userError("Enter a question for Audit Copilot", 400);
  const normalized = question.trim();
  if (normalized.length > MAX_QUESTION_LENGTH) throw userError(`Question exceeds the ${MAX_QUESTION_LENGTH.toLocaleString()} character limit`, 400);
  return normalized;
}

export function assertCopilotQuestionSafe(question) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(String(question || "")))) {
    throw userError("Do not paste private keys, seed phrases, passwords, authenticated RPC URLs, or API tokens into Audit Copilot. Fresh Anvil uses disposable local actors and never needs signing secrets.", 400);
  }
  return question;
}

export function validateCopilotResult({ source, findingIds }, result) {
  const lines = source.split("\n");
  const knownIds = new Set(findingIds);
  const citations = (Array.isArray(result?.citations) ? result.citations : []).map((citation) => {
    const validRange = Number.isInteger(citation.lineStart) && Number.isInteger(citation.lineEnd) &&
      citation.lineStart >= 1 && citation.lineEnd >= citation.lineStart && citation.lineEnd <= lines.length;
    const quote = typeof citation.quote === "string" ? citation.quote.trim() : "";
    const sourceRange = validRange ? lines.slice(citation.lineStart - 1, citation.lineEnd).join("\n") : "";
    return { ...citation, sourceValidated: Boolean(quote) && sourceRange.includes(quote) };
  }).filter((citation) => citation.sourceValidated);
  let answer = typeof result?.answer === "string" && result.answer.trim()
    ? result.answer.trim()
    : "Audit Copilot did not return an answer.";
  if (/```\s*(?:solidity|diff)|diff\s+--git|\*\*\*\s+Begin Patch|\bpragma\s+solidity\b/i.test(answer)) {
    answer = "Attest is audit-only and will not provide replacement Solidity, rewritten contract code, or patches. The recorded evidence and points to address remain available in the audit feed.";
  }
  return {
    answer,
    citations,
    relatedFindingIds: (Array.isArray(result?.relatedFindingIds) ? result.relatedFindingIds : []).filter((id) => knownIds.has(id)),
    suggestedNextSteps: (Array.isArray(result?.suggestedNextSteps) ? result.suggestedNextSteps : []).slice(0, 5),
    requestedAction: result?.requestedAction === "run-current-continuation" ? "run-current-continuation" : "none",
    deploymentPlanCandidates: (Array.isArray(result?.deploymentPlanCandidates) ? result.deploymentPlanCandidates : []).filter((item) => item && typeof item === "object").slice(0, 1),
    developerContextCandidates: (Array.isArray(result?.developerContextCandidates) ? result.developerContextCandidates : []).filter((item) => item && typeof item === "object").slice(0, 8),
  };
}

function userError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
