import { useEffect, useRef, useState } from 'react';
import { createChromeHost, type ChromeHost } from './host.js';

/**
 * The chrome host of the frame's current document, alive only while `active`
 * (an editing session in Edit mode). A frame reload is a new document and gets
 * a new host; leaving Edit mode, losing the lock, ending the session or
 * unmounting removes it. The result is `null` whenever there is no host.
 *
 * The host is keyed by `Document`, not by the frame's window: the window proxy
 * stays the same across navigations.
 */
export function useChromeHost(
  frame: HTMLIFrameElement | null,
  active: boolean,
  theme: string | null,
): ChromeHost | null {
  const [chromeHost, setChromeHost] = useState<ChromeHost | null>(null);
  // Read when a host is built, so a theme change never rebuilds it.
  const themeRef = useRef(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    if (frame === null || !active) return undefined;
    let current: ChromeHost | null = null;
    let currentDocument: Document | null = null;

    const build = (): void => {
      const frameDocument = frame.contentDocument;
      if (
        frameDocument === null ||
        frameDocument.URL === 'about:blank' ||
        frameDocument.readyState !== 'complete' ||
        frameDocument === currentDocument
      ) {
        return;
      }
      current?.dispose();
      currentDocument = frameDocument;
      current = createChromeHost(frameDocument, { theme: themeRef.current });
      setChromeHost(current);
    };

    frame.addEventListener('load', build);
    build();
    return () => {
      frame.removeEventListener('load', build);
      current?.dispose();
      current = null;
      currentDocument = null;
      setChromeHost(null);
    };
  }, [frame, active]);

  useEffect(() => {
    chromeHost?.setTheme(theme);
  }, [chromeHost, theme]);

  return chromeHost;
}
