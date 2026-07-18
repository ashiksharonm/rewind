import { useEffect, useState } from 'react';
import { api } from './api';
import type { Health } from './types';
import { Dashboard } from './components/Dashboard';
import { TraceView } from './components/TraceView';
import { CompareView } from './components/CompareView';

type Route =
  | { page: 'dashboard' }
  | { page: 'run'; id: string }
  | { page: 'compare'; a: string; b: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'run' && parts[1]) return { page: 'run', id: parts[1] };
  if (parts[0] === 'compare' && parts[1] && parts[2]) return { page: 'compare', a: parts[1], b: parts[2] };
  return { page: 'dashboard' };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-mark">⟲</span>
          Rewind
          <span className="sub">time-machine debugging for agents</span>
        </a>
        <div className="spacer" />
        {health && (
          <>
            <span className="mode-chip">
              <span className={`dot ${health.mode}`} />
              {health.mode === 'live' ? `live · ${health.model}` : 'simulated model'}
            </span>
            <span className="mode-chip">MCP · {health.tools.length} tools</span>
          </>
        )}
        <a
          className="mode-chip"
          href="https://github.com/ashiksharonm/rewind/issues"
          target="_blank"
          rel="noreferrer"
          title="Report a bug or suggest a feature"
        >
          ★ Feedback
        </a>
      </header>
      <main className="container">
        {route.page === 'dashboard' && <Dashboard health={health} />}
        {route.page === 'run' && <TraceView runId={route.id} />}
        {route.page === 'compare' && <CompareView aId={route.a} bId={route.b} />}
      </main>
    </div>
  );
}
