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

/**
 * The path the Edit pill sends a browser to (D-10). The server decides there:
 * a valid session continues straight to the page in edit mode, anything else
 * gets the login screen over that page.
 */
export const CMS_LOGIN_PATH = '/cms';

/** The query parameter carrying the page to return to after login (D-10). */
export const NEXT_PARAM = 'next';
