/**
 * Fixture-only: a stateful client component mounted into the edit page's
 * light DOM, so a test can prove React Fast Refresh keeps state for a
 * hydrated entry that is not a route. Loaded only when E2E_REFRESH_PROBE=1.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

export function RefreshProbe() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((n) => n + 1)}>
      count {count} v1
    </button>
  );
}

// Mount once: a hot update re-runs this module, and the guard keeps the
// existing root so Fast Refresh swaps the component inside it.
if (document.getElementById('refresh-probe') === null) {
  const host = document.createElement('div');
  host.id = 'refresh-probe';
  // Above the edit shell, which covers the whole viewport.
  host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647';
  document.body.append(host);
  createRoot(host).render(<RefreshProbe />);
}
