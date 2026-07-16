const forbiddenDependencies = new Map([
  ["redis", "redis"],
  ["ioredis", "redis"],
  ["@upstash/redis", "redis"],
  ["bullmq", "bullmq"],
  ["aws-sdk", "object-store"],
  ["@aws-sdk/client-s3", "object-store"],
  ["@aws-sdk/lib-storage", "object-store"],
  ["minio", "object-store"],
  ["@google-cloud/storage", "object-store"],
  ["@azure/storage-blob", "object-store"],
  ["multer-s3", "object-store"],
  ["s3rver", "object-store"],
]);

export function forbiddenInfrastructureCategory(dependency) {
  const normalizedDependency = dependency.trim().toLowerCase();

  if (normalizedDependency.startsWith("@redis/")) {
    return "redis";
  }

  return forbiddenDependencies.get(normalizedDependency) ?? null;
}
