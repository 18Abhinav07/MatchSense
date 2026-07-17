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
