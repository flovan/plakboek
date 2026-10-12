/**
 * The pre-paint layout script of the edit shell.
 *
 * The shell is server-rendered in its framed layout, but an editor who chose
 * full width expects it to stay that way on the next page. The choice lives
 * in `localStorage`, which only the browser can read, so a tiny inline script
 * applies it before the first paint and the framed layout never flashes. It
 * runs right after the host element, before the editor's own chunk has
 * loaded, and works without it.
 *
 * The script is constant text: it reads one key, compares it to the literal
 * `full` and sets one attribute. Shared caches never see it (edit responses
 * are private), but a static text also means its `sha256-...` source can be
 * listed in the shell's `script-src` without a per-request nonce, and no
 * inline script is allowed any other way.
 */
import { HOST_TAG } from '../chrome/island.js';
import { cspHashOf } from './html-document.js';

/** The `localStorage` key holding `framed` or `full`. The browser-side
 * reader (`client/shell/layout.ts`) names the same key; a unit test holds
 * the two together. */
export const LAYOUT_STORAGE_KEY = 'plakboek:editor-layout';

/**
 * Sets `data-layout="full"` on the editor host when, and only when, the
 * stored value is exactly `full`. A missing key, any other value or storage
 * that throws (privacy modes) leaves the framed layout the server rendered.
 */
export const LAYOUT_SCRIPT = [
  '(function(){try{',
  `if(localStorage.getItem(${JSON.stringify(LAYOUT_STORAGE_KEY)})==="full"){`,
  `var h=document.querySelector(${JSON.stringify(HOST_TAG)});`,
  'if(h)h.setAttribute("data-layout","full")}',
  '}catch(e){}})();',
].join('');

/** The CSP source that allows exactly `LAYOUT_SCRIPT`. */
export const LAYOUT_SCRIPT_CSP_HASH = cspHashOf(LAYOUT_SCRIPT);
