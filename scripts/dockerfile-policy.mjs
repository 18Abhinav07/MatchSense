export function runtimeStageContents(dockerfile) {
  const runtimeHeader = /^FROM [^\r\n]+ AS runtime\s*$/gmu.exec(dockerfile);
  if (!runtimeHeader) {
    return "";
  }

  const stageStart = runtimeHeader.index + runtimeHeader[0].length;
  const remainder = dockerfile.slice(stageStart);
  const nextStage = remainder.search(/^FROM\s+/mu);
  return nextStage === -1 ? remainder : remainder.slice(0, nextStage);
}

export function runtimeAptPackages(dockerfile) {
  const runtimeStage = runtimeStageContents(dockerfile).replace(
    /\\\r?\n\s*/gu,
    " ",
  );
  const install = runtimeStage.match(
    /\bapt-get install -y --no-install-recommends\s+(.+?)\s+&&/u,
  );

  return install ? install[1].trim().split(/\s+/u) : [];
}

const allowedRuntimeAptInstall =
  "apt-get install -y --no-install-recommends ffmpeg";
const allowedRuntimeRun = `RUN apt-get update && ${allowedRuntimeAptInstall} && rm -rf /var/lib/apt/lists/*`;

const forbiddenPackageManagerPatterns = [
  [
    "apt-install",
    /\b(?:apt(?:-get)?|aptitude)\b.*\b(?:install|download|source)\b/iu,
  ],
  ["apk-add", /\bapk\b.*\badd\b/iu],
  [
    "system-package-install",
    /\b(?:dnf|yum|microdnf|zypper)\b.*\b(?:install|add)\b|\bpacman\b.*\s-S(?:\s|$)|\bdpkg\b.*\s-(?:i|unpack)(?:\s|$)/iu,
  ],
  [
    "language-package-install",
    /\b(?:npm|pnpm|yarn|bun)\b.*\b(?:install|add|i)\b/iu,
  ],
  ["language-package-install", /\b(?:pip3?|gem|cargo|go)\b.*\binstall\b/iu],
];

export function forbiddenRuntimeInstallCommands(dockerfile) {
  const runtimeStage = runtimeStageContents(dockerfile).replace(
    /\\\r?\n\s*/gu,
    " ",
  );
  const violations = [];

  for (const instruction of runtimeStage.split(/\r?\n/u)) {
    const trimmedInstruction = instruction.trim();
    const normalizedInstruction = trimmedInstruction.replace(/\s+/gu, " ");
    if (normalizedInstruction === allowedRuntimeRun) {
      continue;
    }

    if (/^ADD\s+/iu.test(trimmedInstruction)) {
      violations.push(
        /^ADD\s+(?:--\S+\s+)*https?:\/\//iu.test(trimmedInstruction)
          ? "remote-add"
          : "unexpected-runtime-add",
      );
      continue;
    }

    if (!/^RUN\s+/iu.test(trimmedInstruction)) {
      continue;
    }

    const violationCount = violations.length;
    const command = trimmedInstruction.replace(/^RUN\s+/iu, "");
    for (const segment of command.split(/\s*(?:&&|\|\||;)\s*/u)) {
      const normalizedSegment = segment.trim();
      if (normalizedSegment === allowedRuntimeAptInstall) {
        continue;
      }

      const packageManager = forbiddenPackageManagerPatterns.find(
        ([, pattern]) => pattern.test(normalizedSegment),
      );
      if (packageManager) {
        violations.push(packageManager[0]);
        continue;
      }

      if (
        /\b(?:curl|wget)\b|\bgit\s+clone\b|\bfetch\s*\(\s*["']https?:\/\//iu.test(
          normalizedSegment,
        )
      ) {
        violations.push("remote-download");
      }
    }

    if (violations.length === violationCount) {
      violations.push("unexpected-runtime-run");
    }
  }

  return violations;
}
