import {
  EDIT_PARAM,
  EDITOR_FLAG_KEY,
  NOOP_EDIT,
  TOOLBAR_DISMISSED_KEY,
  type BlockComponent,
  type BlockComponentProps,
  type BlockIdentity,
  type DocumentInput,
  type EditAttributes,
  type EditProxy,
  type PageHead,
  type RenderDocument,
} from '@plakboek/render';
import {
  buildPageHead,
  renderDefaultDocument,
  renderHeadHtml,
  renderToolbarBootstrap,
  TOOLBAR_BOOTSTRAP_CSP_HASH,
  type PageHeadInput,
  type PageSeoInput,
} from '@plakboek/render/server';

const failures: string[] = [];

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    failures.push(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

expectEqual('EDIT_PARAM', EDIT_PARAM, '_edit');
expectEqual('EDITOR_FLAG_KEY', EDITOR_FLAG_KEY.startsWith('plakboek:'), true);
expectEqual(
  'TOOLBAR_DISMISSED_KEY',
  TOOLBAR_DISMISSED_KEY.startsWith('plakboek:'),
  true,
);
expectEqual('NOOP_EDIT keys', Object.keys(NOOP_EDIT).length, 0);
expectEqual(
  'NOOP_EDIT field keys',
  Object.keys(NOOP_EDIT.field('title')).length,
  0,
);

// The root entry's types, proven by assignment only (nothing is constructed
// that React would have to render).
const identity: BlockIdentity = { id: 'b1', blockType: 'x', schemaVersion: 1 };
const proxy: EditProxy = NOOP_EDIT;
const attributes: EditAttributes = proxy.field('title');
const probeProps = (props: BlockComponentProps): BlockIdentity => props.block;
const component: BlockComponent = (props) => probeProps(props).blockType;
const seo: PageSeoInput = {
  title: '</title><script>alert(1)</script>',
  description: '"><img src=x>',
  imageAssetId: null,
  canonicalUrl: null,
  noindex: false,
  nofollow: false,
};
const headInput: PageHeadInput = {
  lang: 'en',
  pageTitle: 'Fallback',
  seo,
  publicPath: '/en/about',
  siteUrl: 'https://example.test',
};
const head: PageHead = buildPageHead(headInput);
const input: DocumentInput = {
  head,
  body: '<main>probe</main>',
  publicPath: '/en/about',
};
const composer: RenderDocument = renderDefaultDocument;

const headMarkup = renderHeadHtml(head);
const html = await composer(input);

expectEqual(
  'canonical from siteUrl',
  head.canonicalUrl,
  'https://example.test/en/about',
);
expectEqual('head has no script', headMarkup.includes('<script'), false);
expectEqual('document doctype', html.startsWith('<!DOCTYPE html>'), true);
expectEqual('document has no script', html.includes('<script'), false);
expectEqual('document body', html.includes('<main>probe</main>'), true);
expectEqual(
  'bootstrap CSP hash',
  TOOLBAR_BOOTSTRAP_CSP_HASH.startsWith('sha256-'),
  true,
);
expectEqual(
  'bootstrap is one inline script',
  renderToolbarBootstrap().startsWith('<script>'),
  true,
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(
  `render.ts: both subpaths resolve from the packed package (${identity.id}, ${typeof attributes}, ${typeof component} typed)`,
);
