export function strictSchemaIssues(schema, path = "$") {
  const issues = [];
  visit(schema, path, issues);
  return issues;
}

function visit(schema, path, issues) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (schema.properties && typeof schema.properties === "object") {
    const propertyNames = Object.keys(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    const missing = propertyNames.filter((name) => !required.includes(name));
    const unknown = required.filter((name) => !propertyNames.includes(name));
    if (missing.length) issues.push(`${path}: required is missing ${missing.join(", ")}`);
    if (unknown.length) issues.push(`${path}: required contains unknown ${unknown.join(", ")}`);
    if (schema.additionalProperties !== false) issues.push(`${path}: additionalProperties must be false`);
    for (const [name, child] of Object.entries(schema.properties)) visit(child, `${path}.properties.${name}`, issues);
  }
  if (schema.items) visit(schema.items, `${path}.items`, issues);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[keyword])) schema[keyword].forEach((child, index) => visit(child, `${path}.${keyword}[${index}]`, issues));
  }
}
