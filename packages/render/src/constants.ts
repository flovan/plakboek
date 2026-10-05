/**
 * Constants shared between the visitor handler and the editor bootstrap.
 * The storage keys hold non-secret flags only: they are read by the small
 * bootstrap script every visitor page carries, never by anything that
 * authorises an action.
 */

/** The query parameter that asks the handler for the editor entry (D-03). */
export const EDIT_PARAM = '_edit';

/** localStorage key set once a user has signed in to edit (D-03). */
export const EDITOR_FLAG_KEY = 'plakboek:editor';

/** localStorage key set when the user dismisses the editing toolbar (D-03). */
export const TOOLBAR_DISMISSED_KEY = 'plakboek:toolbar-dismissed';
