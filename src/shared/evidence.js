export function displayClassification(aiReview) {
  if (!aiReview) return null;
  return aiReview.sourceValidated ? aiReview.classification : "unvalidated AI hypothesis";
}
