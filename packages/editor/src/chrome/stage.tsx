import type { ReactElement } from 'react';
import { FrameErrorPanel, NarrowWindowPanel } from './panels.js';
import { STRINGS } from './strings.js';

/** The id the skip link moves focus to. */
export const STAGE_ID = 'plakboek-stage';

export type StageProps = {
  readonly frameUrl: string;
  /** The page is being edited in Edit mode: the region becomes a tab stop. */
  readonly editRegion?: boolean;
  /** The frame holds the render-failure page: show the panel instead. */
  readonly frameFailed?: boolean;
  /** Called by the failure panel's Reload page button. */
  readonly onReload?: () => void;
};

/**
 * The stage: the region the page is shown in, holding one same-origin iframe
 * used purely as a viewport onto the site. The iframe's `src` is the same in
 * the server markup and in the hydrated tree, so hydrating never reloads it.
 * Geometry (the padding around the frame, the layouts) lives in the chrome
 * stylesheet's `:host` rules.
 *
 * Below 1024px wide the shell does not attempt a layout: the frame is hidden
 * and the narrow-window panel takes its place. That is a media query on the
 * markup itself, so it holds before any script has run and lifts without a
 * reload when the window grows. When the frame holds the failure page the
 * iframe stays in place (hidden) and the failure panel is drawn instead.
 */
export function Stage(props: StageProps): ReactElement {
  const { frameUrl, editRegion = false, frameFailed = false, onReload } = props;
  return (
    <div
      id={STAGE_ID}
      className="pk-stage focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
      role="region"
      aria-label={
        editRegion ? STRINGS['landmark.editRegion'] : STRINGS['landmark.frame']
      }
      tabIndex={editRegion ? 0 : -1}
    >
      <iframe
        className={
          frameFailed ? 'pk-frame hidden' : 'pk-frame max-[1024px]:hidden'
        }
        src={frameUrl}
        title={STRINGS['landmark.frame']}
      />
      {frameFailed ? (
        <div className="h-full max-[1024px]:hidden">
          <FrameErrorPanel onReload={onReload} />
        </div>
      ) : null}
      <div className="hidden h-full max-[1024px]:block">
        <NarrowWindowPanel />
      </div>
    </div>
  );
}
