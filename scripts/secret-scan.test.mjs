import assert from "node:assert/strict";
import test from "node:test";

const sensitiveNames = [
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PRIVATE_KEY",
  "API_KEY",
];

async function loadScanner() {
  try {
    return await import("./secret-scan.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      return null;
    }

    throw error;
  }
}

function toCamelCase(name) {
  return name
    .toLowerCase()
    .replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase());
}

test("detects generic and algorithm-specific private-key PEMs", async () => {
  const scanner = await loadScanner();
  assert.notEqual(scanner, null, "secret-scan helper must exist");

  for (const keyKind of ["", "RSA ", "EC ", "OPENSSH ", "DSA "]) {
    const pem = ["-----BEGIN", `${keyKind}PRIVATE KEY-----`].join(" ");
    const findings = scanner.scanCommittedSecrets("fixture.txt", pem);

    assert.equal(
      findings.some((finding) => finding.kind === "private-key-pem"),
      true,
      `${keyKind || "generic "}private key must be detected`,
    );
  }
});

test("detects nonempty sensitive assignments in ENV, JS, TS, JSON, and YAML", async () => {
  const scanner = await loadScanner();
  assert.notEqual(scanner, null, "secret-scan helper must exist");

  const fixtures = [
    [".env", sensitiveNames.map((name) => `${name}=fixture-value`).join("\n")],
    [
      "fixture.js",
      sensitiveNames
        .map((name) => `const ${toCamelCase(name)} = "fixture-value";`)
        .join("\n"),
    ],
    [
      "fixture.ts",
      sensitiveNames
        .map((name) => `config.${toCamelCase(name)} = "fixture-value";`)
        .join("\n"),
    ],
    [
      "fixture.json",
      JSON.stringify(
        Object.fromEntries(
          sensitiveNames.map((name) => [toCamelCase(name), "fixture-value"]),
        ),
      ),
    ],
    [
      "fixture.yaml",
      sensitiveNames
        .map((name) => `${name.toLowerCase()}: fixture-value`)
        .join("\n"),
    ],
  ];

  for (const [filePath, contents] of fixtures) {
    assert.equal(
      scanner
        .scanCommittedSecrets(filePath, contents)
        .filter((finding) => finding.kind === "secret-assignment").length,
      sensitiveNames.length,
      `${filePath} must report every sensitive assignment`,
    );
  }
});

test("allows empty examples, runtime lookups, and prose", async () => {
  const scanner = await loadScanner();
  assert.notEqual(scanner, null, "secret-scan helper must exist");

  const emptyEnvironment = sensitiveNames
    .map((name, index) => `${name}=${index % 2 === 0 ? "" : '\"\"'}`)
    .join("\n");
  const runtimeTypeScript = [
    ["const api", "Key = process.env.API_KEY;"].join(""),
    ["const access", "Token = getToken();"].join(""),
    ["const pass", 'word = "";'].join(""),
    ["type Private", "Key = string;"].join(""),
  ].join("\n");
  const emptyJson = JSON.stringify(
    Object.fromEntries(sensitiveNames.map((name) => [toCamelCase(name), ""])),
  );
  const emptyYaml = sensitiveNames
    .map((name) => `${name.toLowerCase()}: ""`)
    .join("\n");
  const prose = [
    "Set ",
    "API_KEY in your shell; passwords and tokens remain user-provided.",
  ].join("");

  for (const [filePath, contents] of [
    [".env.example", emptyEnvironment],
    ["fixture.ts", runtimeTypeScript],
    ["fixture.json", emptyJson],
    ["fixture.yml", emptyYaml],
    ["README.md", prose],
  ]) {
    assert.deepEqual(
      scanner.scanCommittedSecrets(filePath, contents),
      [],
      `${filePath} must not produce a false positive`,
    );
  }
});

test("allows only the documented non-secret environment example defaults", async () => {
  const scanner = await loadScanner();
  assert.notEqual(scanner, null, "secret-scan helper must exist");

  assert.equal(
    scanner.isAllowedEnvironmentExampleValue(
      "DATA_RIGHTS_MODE",
      "synthetic_demo",
    ),
    true,
  );
  assert.equal(
    scanner.isAllowedEnvironmentExampleValue(
      "VAPID_SUBJECT",
      "mailto:you@example.com",
    ),
    true,
  );

  for (const [key, value] of [
    ["DATA_RIGHTS_MODE", "authorized_live"],
    ["VAPID_SUBJECT", "mailto:real-team@example.com"],
    ["VAPID_PRIVATE_KEY", "example-private-key"],
    ["UNRELATED_SETTING", "synthetic_demo"],
  ]) {
    assert.equal(
      scanner.isAllowedEnvironmentExampleValue(key, value),
      false,
      `${key}=${value} must not be allowlisted`,
    );
  }
});

test("allows marked synthetic test literals while still detecting test-file secrets", async () => {
  const scanner = await loadScanner();
  assert.notEqual(scanner, null, "secret-scan helper must exist");

  const findings = scanner.scanCommittedSecrets(
    "fixture.test.ts",
    [
      'const password = "sentinel-db-password";',
      'const apiToken = "fixture-activated-token";',
      "const config = {",
      '  token: "production-credential-value",',
      '  privateKey: "production-private-material",',
      "};",
    ].join("\n"),
  );

  assert.deepEqual(
    findings.map(({ key }) => key),
    ["token", "privateKey"],
    "test files may contain explicit fixtures, but ordinary nonempty credentials must still be rejected",
  );
});
