import {
  CMS_LOGIN_PATH,
  Columns,
  columnTracks,
  defineBlockEdit,
  EDIT_ATTRIBUTE,
  EDIT_PARAM,
  EDITOR_FLAG_KEY,
  NEXT_PARAM,
  NOOP_EDIT,
  TOOLBAR_DISMISSED_KEY,
  type BlockComponent,
  type BlockComponentProps,
  type BlockIdentity,
  type BlockLayout,
  type DocumentInput,
  type EditAttributes,
  type EditProxy,
  type PageHead,
  type RenderDocument,
} from '@plakboek/render';
import {
  buildPageHead,
  createLiveEdit,
  normalizeVisitorPath,
  renderDefaultDocument,
  renderHeadHtml,
  renderPageTree,
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
expectEqual('EDIT_ATTRIBUTE.block', EDIT_ATTRIBUTE.block, 'data-pk-block');
expectEqual('renderPageTree', typeof renderPageTree, 'function');
expectEqual(
  'createLiveEdit root attributes',
  Object.keys(
    createLiveEdit({ id: 'b1', blockType: 'x', kind: 'block', label: 'X' }),
  ).length,
  4,
);
expectEqual(
  'normalizeVisitorPath',
  normalizeVisitorPath('/About').kind,
  'redirect',
);
const probeLayout: BlockLayout = { columns: '2:1' };
expectEqual(
  'columnTracks',
  columnTracks(probeLayout.columns, 2),
  'minmax(0, 2fr) minmax(0, 1fr)',
);
// The element is read through its props rather than rendered: the probe
// installs no React type packages, and `Columns` is a plain function.
const gridElement: unknown = Columns({
  layout: probeLayout,
  children: ['one', 'two'],
});
const gridProps: unknown =
  typeof gridElement === 'object' && gridElement !== null
    ? Reflect.get(gridElement, 'props')
    : undefined;
const gridStyle: unknown =
  typeof gridProps === 'object' && gridProps !== null
    ? Reflect.get(gridProps, 'style')
    : undefined;
expectEqual(
  'Columns grid tracks',
  typeof gridStyle === 'object' && gridStyle !== null
    ? Reflect.get(gridStyle, '--plakboek-columns-tracks')
    : undefined,
  'minmax(0, 2fr) minmax(0, 1fr)',
);
const probeEdit = {
  blockType: 'accordion',
  hooks: { select: () => undefined },
};
expectEqual(
  'defineBlockEdit is an identity',
  defineBlockEdit(probeEdit),
  probeEdit,
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
  mode: 'visitor',
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
expectEqual('login path', CMS_LOGIN_PATH, '/cms');
expectEqual('next parameter', NEXT_PARAM, 'next');
expectEqual('document mode type', input.mode, 'visitor');
expectEqual(
  'bootstrap targets the login path',
  renderToolbarBootstrap().includes(JSON.stringify(CMS_LOGIN_PATH)),
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
