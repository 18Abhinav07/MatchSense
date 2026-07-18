import path from "node:path";

const sensitiveIdentifierPatterns = [
  /(?:^|_)SECRET(?:_|$)/u,
  /(?:^|_)TOKEN(?:_|$)/u,
  /(?:^|_)PASSWORD(?:_|$)/u,
  /(?:^|_)PRIVATE_KEY(?:_|$)/u,
  /(?:^|_)API_KEY(?:_|$)/u,
];

const allowedEnvironmentExampleValues = new Map([
  ["DATA_RIGHTS_MODE", "synthetic_demo"],
  ["VAPID_SUBJECT", "mailto:you@example.com"],
]);

function lineNumberAt(contents, index) {
  return contents.slice(0, index).split("\n").length;
}

function isEnvironmentFilePath(filePath) {
  return /(?:^|\.)env(?:\.|$)/u.test(path.basename(filePath).toLowerCase());
}

function isSensitiveIdentifier(identifier) {
  const normalizedIdentifier = identifier
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();

  if (normalizedIdentifier === "FENCING_TOKEN") {
    return false;
  }

  return sensitiveIdentifierPatterns.some((pattern) =>
    pattern.test(normalizedIdentifier),
  );
}

function isEmptyConfigurationValue(rawValue) {
  const value = rawValue.trim();

  return (
    value === "" ||
    /^(?:""|'')\s*(?:#.*)?$/u.test(value) ||
    /^(?:null|undefined|~|\[\]|\{\})\s*(?:#.*)?$/iu.test(value) ||
    value.startsWith("#")
  );
}

function literalString(rawValue) {
  const value = rawValue
    .trim()
    .replace(/[;,]\s*$/u, "")
    .trim();
  const quote = value.at(0);

  if (['"', "'", "`"].includes(quote) && value.at(-1) === quote) {
    return value.slice(1, -1);
  }

  return null;
}

function isNonemptyLiteral(rawValue) {
  const value = rawValue
    .trim()
    .replace(/[;,]\s*$/u, "")
    .trim();

  if (isEmptyConfigurationValue(value)) {
    return false;
  }

  const literal = literalString(value);
  if (literal !== null) {
    return literal !== "" && !/^\$\{[^}]+\}$/u.test(literal);
  }

  return /^(?:[-+]?\d|true\b|false\b|\[|\{)/u.test(value);
}

function secretAssignment(line, key) {
  return {
    kind: "secret-assignment",
    line,
    key,
  };
}

function isMarkedSyntheticTestLiteral(rawValue) {
  const literal = literalString(rawValue);
  return (
    literal !== null &&
    /^(?:fixture|sentinel)-[A-Za-z0-9][\w.:-]*$/u.test(literal)
  );
}

function scanEnvironment(contents) {
  const findings = [];

  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    const assignment = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u,
    );

    if (
      assignment &&
      isSensitiveIdentifier(assignment[1]) &&
      !isEmptyConfigurationValue(assignment[2])
    ) {
      findings.push(secretAssignment(index + 1, assignment[1]));
    }
  }

  return findings;
}

function scanJavaScript(contents, allowSyntheticTestLiterals) {
  const findings = [];

  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const variableAssignment = line.match(
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*?)\s*$/u,
    );

    if (
      variableAssignment &&
      isSensitiveIdentifier(variableAssignment[1]) &&
      isNonemptyLiteral(variableAssignment[2]) &&
      !(
        allowSyntheticTestLiterals &&
        isMarkedSyntheticTestLiteral(variableAssignment[2])
      )
    ) {
      findings.push(secretAssignment(lineNumber, variableAssignment[1]));
    }

    const propertyAssignment = line.match(
      /^\s*(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*=(?!=|>)\s*(.*?)\s*$/u,
    );

    if (
      propertyAssignment &&
      isSensitiveIdentifier(propertyAssignment[1]) &&
      isNonemptyLiteral(propertyAssignment[2]) &&
      !(
        allowSyntheticTestLiterals &&
        isMarkedSyntheticTestLiteral(propertyAssignment[2])
      )
    ) {
      findings.push(secretAssignment(lineNumber, propertyAssignment[1]));
    }

    const objectPropertyPattern =
      /(?:^|[{,])\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:\s*([^,}\n]+)/gu;
    for (const property of line.matchAll(objectPropertyPattern)) {
      const key = property[1] ?? property[2] ?? property[3];
      if (
        key &&
        isSensitiveIdentifier(key) &&
        isNonemptyLiteral(property[4]) &&
        !(
          allowSyntheticTestLiterals &&
          isMarkedSyntheticTestLiteral(property[4])
        )
      ) {
        findings.push(secretAssignment(lineNumber, key));
      }
    }
  }

  return findings;
}

function hasNonemptyJsonValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim() !== "";
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

function scanJson(contents) {
  const findings = [];
  const document = JSON.parse(contents);

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (value === null || typeof value !== "object") {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveIdentifier(key) && hasNonemptyJsonValue(child)) {
        const keyIndex = contents.indexOf(JSON.stringify(key));
        findings.push(
          secretAssignment(
            keyIndex === -1 ? 1 : lineNumberAt(contents, keyIndex),
            key,
          ),
        );
      }
      visit(child);
    }
  }

  visit(document);
  return findings;
}

function scanYaml(contents) {
  const findings = [];

  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (line.trimStart().startsWith("#")) {
      continue;
    }

    const property = line.match(
      /^\s*(?:-\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*(.*?)\s*$/u,
    );
    const key = property?.[1] ?? property?.[2] ?? property?.[3];
    const value = property?.[4];

    if (
      key &&
      value !== undefined &&
      isSensitiveIdentifier(key) &&
      !isEmptyConfigurationValue(value)
    ) {
      findings.push(secretAssignment(index + 1, key));
    }
  }

  return findings;
}

export function isAllowedEnvironmentExampleValue(key, value) {
  return allowedEnvironmentExampleValues.get(key) === value;
}

export function isForbiddenCommittedEnvironmentFile(filePath) {
  return isEnvironmentFilePath(filePath) && filePath !== ".env.example";
}

export function scanCommittedSecrets(filePath, contents) {
  const findings = [];
  const pemHeaderPattern =
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu;

  for (const match of contents.matchAll(pemHeaderPattern)) {
    findings.push({
      kind: "private-key-pem",
      line: lineNumberAt(contents, match.index),
    });
  }

  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(basename);

  if (isEnvironmentFilePath(filePath)) {
    findings.push(...scanEnvironment(contents));
  } else if (
    [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(
      extension,
    )
  ) {
    findings.push(
      ...scanJavaScript(contents, /\.(?:test|spec)\.[^.]+$/u.test(basename)),
    );
  } else if (extension === ".json") {
    findings.push(...scanJson(contents));
  } else if ([".yaml", ".yml"].includes(extension)) {
    findings.push(...scanYaml(contents));
  }

  return findings;
}
