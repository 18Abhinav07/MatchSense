import { AppRouter, type AppRouterProps } from "./routes/AppRouter.js";
import { ListeningProvider } from "./ListeningProvider.js";

export type AppProps = AppRouterProps;

/**
 * The public PWA owns no fixture fallback or demo state. AppRouter receives
 * only server-backed product ports, keeping browser rendering honest when a
 * match, archive, stream, or profile is not currently available.
 */
export function App(props: AppProps = {}) {
  return (
    <ListeningProvider>
      <AppRouter {...props} />
    </ListeningProvider>
  );
}
