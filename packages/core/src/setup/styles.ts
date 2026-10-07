/**
 * The setup screens' stylesheet and the Content-Security-Policy that allows
 * exactly it (D-12). The page never reads the host theme or stylesheet: the
 * CSS below is the whole of its styling, inlined into every response, so a
 * host that restyles its site cannot break first-run and first-run cannot
 * leak into the host.
 *
 * Palette, spacing and type follow the first-run contract: a system font
 * stack, light only, 44px controls, a 2px focus outline, a fluid card that
 * never exceeds 480px, and no motion.
 */
import { createHash } from 'node:crypto';

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export const SETUP_STYLES = [
  '*,*::before,*::after{box-sizing:border-box}',
  'html{color-scheme:light}',
  `body{margin:0;min-height:100vh;padding:16px;display:flex;align-items:center;justify-content:center;background:#f4f4f5;color:#27272a;font-family:${FONT_STACK};font-size:16px;font-weight:400;line-height:1.5}`,
  'main{width:100%;max-width:480px;padding:32px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px}',
  'h1{margin:0 0 8px;font-size:20px;font-weight:600;line-height:1.2}',
  'main.done h1{margin-bottom:48px}',
  'p{margin:0 0 16px}',
  'p.note,p.hint,p.result,p.error{font-size:14px;font-weight:400}',
  'p.note,p.hint{color:#71717a}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}',
  '.wrap{overflow-wrap:anywhere}',
  '.field{margin:0 0 16px}',
  'label,.label{display:block;margin:0 0 8px;font-size:14px;font-weight:600;line-height:1.5}',
  'input[type=text],input[type=email],input[type=password]{display:block;width:100%;height:44px;padding:0 12px;font:inherit;color:#27272a;background:#ffffff;border:1px solid #71717a;border-radius:8px}',
  'input[aria-invalid=true]{border-color:#b91c1c}',
  'p.hint,p.error{margin:4px 0 0}',
  'p.error{color:#b91c1c}',
  '.summary{margin:0 0 16px;padding:16px;border:1px solid #b91c1c;border-radius:8px}',
  '.summary .label{margin:0 0 8px;color:#b91c1c}',
  '.summary ul{margin:0;padding:0 0 0 20px;font-size:14px}',
  '.summary a{color:#b91c1c}',
  '.button{display:flex;align-items:center;justify-content:center;width:100%;height:44px;margin:0;padding:0 16px;font:inherit;font-size:14px;font-weight:600;line-height:1.5;text-decoration:none;cursor:pointer;border-radius:8px}',
  '.primary{color:#ffffff;background:#18181b;border:1px solid #18181b}',
  '.primary:hover{background:#27272a}',
  '.secondary{color:#18181b;background:#ffffff;border:1px solid #71717a}',
  '.actions{margin-top:24px}',
  'hr{margin:24px 0;border:0;border-top:1px solid #e4e4e7}',
  'p.result{margin:8px 0 0}',
  ':focus{outline:2px solid #18181b;outline-offset:2px}',
].join('');

/**
 * Every setup response: nothing may load (`default-src 'none'`), the one
 * inline stylesheet is allowed by its hash, forms may post only to this
 * origin, and the page cannot be framed. There is no `script-src` because
 * the page has no script.
 */
export const SETUP_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(SETUP_STYLES, 'utf8').digest('base64')}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
