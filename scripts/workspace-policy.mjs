const forbiddenDependencies = new Map([
  ["redis", "redis"],
  ["ioredis", "redis"],
  ["bullmq", "bullmq"],
  ["@aws-sdk/client-s3", "object-store"],
  ["minio", "object-store"],
  ["@google-cloud/storage", "object-store"],
  ["@azure/storage-blob", "object-store"],
]);

export function forbiddenInfrastructureCategory(dependency) {
  const normalizedDependency = dependency.trim().toLowerCase();

  if (normalizedDependency.startsWith("@redis/")) {
    return "redis";
  }

  return forbiddenDependencies.get(normalizedDependency) ?? null;
}
