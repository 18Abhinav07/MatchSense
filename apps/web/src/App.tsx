export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="wordmark" href="/" aria-label="MatchSense home">
          MatchSense
        </a>
        <span className="signal" aria-label="Synthetic preview shell">
          Simulation shell
        </span>
      </header>

      <main id="main-content">
        <p className="eyebrow">Your match, wherever you are</p>
        <h1>Follow every moment.</h1>
        <p className="intro">The production shell for a match companion.</p>
      </main>
    </div>
  );
}
