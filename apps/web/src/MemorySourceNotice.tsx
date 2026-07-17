export type MemoryDataSource = "loading" | "local-fallback" | "server";

export function MemorySourceNotice({ source }: { source: MemoryDataSource }) {
  if (source === "loading") {
    return (
      <p className="memory-source-notice" data-source="loading" role="status">
        SYNCING YOUR MATCH MEMORIES…
      </p>
    );
  }
  if (source === "local-fallback") {
    return (
      <aside
        className="memory-source-notice memory-source-notice--fallback"
        data-source="local-fallback"
        role="status"
      >
        <strong>OFFLINE DEVICE FALLBACK</strong>
        <span>
          Showing this device&apos;s last saved copy because server memory is
          unavailable.
        </span>
      </aside>
    );
  }
  return (
    <p className="memory-source-notice" data-source="server">
      <strong>Synced to your fan profile</strong>
      <span> Final truth and key Moments come from the MatchSense server.</span>
    </p>
  );
}
