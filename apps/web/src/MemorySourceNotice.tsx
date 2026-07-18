export type MemoryDataSource = "loading" | "archive-verified" | "unavailable";

export function MemorySourceNotice({ source }: { source: MemoryDataSource }) {
  if (source === "loading") {
    return (
      <p className="memory-source-notice" data-source="loading" role="status">
        OPENING VERIFIED MATCH MEMORY…
      </p>
    );
  }
  if (source === "unavailable") {
    return (
      <aside
        className="memory-source-notice memory-source-notice--unavailable"
        data-source="unavailable"
        role="status"
      >
        <strong>VERIFIED MEMORY UNAVAILABLE</strong>
        <span>
          MatchSense will not replace an unavailable archive with a browser-made
          memory.
        </span>
      </aside>
    );
  }
  return (
    <p className="memory-source-notice" data-source="archive-verified">
      <strong>ARCHIVE VERIFIED</strong>
      <span>
        {" "}
        Final truth and key Moments come from a TxLINE-backed archive.
      </span>
    </p>
  );
}
