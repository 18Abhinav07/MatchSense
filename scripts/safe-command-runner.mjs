import { spawn } from "node:child_process";

const maximumFailureOutputLength = 4_000;

function sanitizeFailureOutput(output, sensitiveValues = []) {
  let sanitized = String(output);

  const explicitSecrets = [...new Set(sensitiveValues)]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const secret of explicitSecrets) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }

  sanitized = sanitized
    .replace(
      /\b(DATABASE_URL\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/\S+/giu,
      "[REDACTED_URL]",
    )
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/giu,
      "$1$2[REDACTED]",
    )
    .trim();

  if (sanitized.length <= maximumFailureOutputLength) {
    return sanitized;
  }

  return `${sanitized.slice(0, maximumFailureOutputLength)}\n[output truncated]`;
}

export function runLabeledCommand(stage, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", () => reject(new Error(`[${stage}] failed to start`)));
    child.once("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }

      const diagnostic = options.inherit
        ? ""
        : sanitizeFailureOutput(
            Buffer.concat(stderr).toString("utf8"),
            options.sensitiveValues,
          );
      const suffix = diagnostic === "" ? "" : `:\n${diagnostic}`;
      reject(new Error(`[${stage}] exited with code ${String(code)}${suffix}`));
    });
  });
}
