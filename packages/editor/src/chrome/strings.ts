/**
 * Every string edit mode shows, in one module with stable dotted keys, so a
 * later translation catalogue changes no component: components ask for a key,
 * never for English text. The values are the English source copy.
 *
 * A `{name}` in a value is a variable. `formatString` requires exactly the
 * variables a key's value names, checked by the compiler. Values are plain
 * text; React escapes them at render, so nothing here is HTML.
 *
 * Tone: plain, second person, no exclamation marks, and nothing that reveals
 * whether an account exists.
 */
export const STRINGS = Object.freeze({
  // Product
  'product.name': 'Plakboek',

  // Sign-in
  'login.signIn.heading': 'Sign in',
  'login.signIn.email.label': 'Email address',
  'login.signIn.password.label': 'Password',
  'login.signIn.forgot': 'Forgot your password?',
  'login.signIn.submit': 'Sign in',
  'login.signIn.magicLink': 'Email me a sign-in link',
  'login.signIn.status.passwordSet':
    'Your password is set. Sign in to continue.',
  'login.signIn.status.passwordReset':
    'Your password has been reset. Sign in to continue.',
  'login.backToSite': 'Back to site',

  // Two-factor
  'login.twoFactor.code.label': 'Authentication code',
  'login.twoFactor.submit': 'Verify',
  'login.twoFactor.totp.heading': 'Enter your code',
  'login.twoFactor.totp.body':
    'Enter the 6-digit code from your authenticator app.',
  'login.twoFactor.totp.useEmail': 'Email me a code instead',
  'login.twoFactor.totp.useBackup': 'Use a backup code',
  'login.twoFactor.backup.heading': 'Use a backup code',
  'login.twoFactor.backup.body':
    'Enter one of the backup codes you saved when you set up two-step sign-in. Each code works once.',
  'login.twoFactor.backup.label': 'Backup code',
  'login.twoFactor.backup.useTotp': 'Use your authenticator app instead',
  'login.twoFactor.email.heading': 'Check your email',
  'login.twoFactor.email.body': 'We emailed a 6-digit code to {maskedEmail}.',
  'login.twoFactor.email.resend': 'Resend code',
  'login.twoFactor.email.useTotp': 'Use your authenticator app instead',
  'login.lockout.heading': 'Too many incorrect codes',
  'login.lockout.body': 'Sign in again to continue.',
  'login.lockout.submit': 'Back to sign in',

  // Sign-in link request and sent
  'login.magicLink.heading': 'Email me a sign-in link',
  'login.magicLink.body':
    "Enter your email address and we'll send a link that signs you in.",
  'login.magicLink.twoFactorNote':
    'Accounts that sign in with a code from an authenticator app cannot use sign-in links.',
  'login.magicLink.submit': 'Send sign-in link',
  'login.magicLink.back': 'Back to sign in',
  'login.magicLink.sent.heading': 'Check your email',
  'login.magicLink.sent.body':
    'If an account exists for {email}, a sign-in link is on its way. The link works once.',
  'login.magicLink.sent.back': 'Back to sign in',

  // Forgotten password
  'login.forgot.heading': 'Reset your password',
  'login.forgot.body':
    "Enter your email address and we'll send a link to choose a new password.",
  'login.forgot.submit': 'Send reset link',
  'login.forgot.back': 'Back to sign in',
  'login.forgot.sent.heading': 'Check your email',
  'login.forgot.sent.body':
    'If an account exists for {email}, a reset link is on its way. The link works once.',
  'login.forgot.sent.back': 'Back to sign in',

  // Choosing a password (invitation and reset landings)
  'login.password.new.label': 'New password',
  'login.password.new.hint':
    'At least {min} characters. A passphrase works well.',
  'login.password.confirm.label': 'Confirm new password',
  'login.setPassword.heading': 'Choose a password',
  'login.setPassword.body':
    "You've been invited to edit this site. Choose a password to finish setting up your account.",
  'login.setPassword.submit': 'Set password',
  'login.resetPassword.heading': 'Choose a new password',
  'login.resetPassword.body': 'Choose a new password for your account.',
  'login.resetPassword.submit': 'Reset password',

  // Sign-in link landing and invalid links
  'login.magicLinkLanding.heading': 'Signing you in',
  'login.magicLinkLanding.status': 'Signing you in.',
  'login.invalidLink.heading': 'This link is no longer valid',
  'login.invalidLink.body':
    'Links work once and expire after a while. Request a new one to continue.',
  'login.invalidLink.reset.submit': 'Request a new reset link',
  'login.invalidLink.signIn.submit': 'Request a new sign-in link',
  'login.invalidLink.invite.body':
    'Ask the person who invited you to send a new invitation.',
  'login.invalidLink.invite.submit': 'Back to sign in',
  'login.invalidLink.twoFactor.heading': 'This link could not sign you in',
  'login.invalidLink.twoFactor.body':
    'If your account uses two-step sign-in, sign-in links are not available. Sign in with your password and a code instead.',

  // In-flight words for a submit button
  'loading.signingIn': 'Signing in',
  'loading.verifying': 'Verifying',
  'loading.sending': 'Sending',
  'loading.saving': 'Saving',
  'loading.checking': 'Checking',

  // Inline field validation
  'validation.email.empty': 'Enter your email address.',
  'validation.email.malformed': 'Enter an address like name@example.com.',
  'validation.password.empty': 'Enter your password.',
  'validation.code.invalid': 'Enter the 6-digit code.',
  'validation.backupCode.empty': 'Enter a backup code.',
  'validation.newPassword.tooShort': 'Use at least {min} characters.',
  'validation.confirm.mismatch': 'The two passwords do not match.',

  // Error box
  'error.credentials':
    'Email or password is incorrect. Check them and try again.',
  'error.rateLimited': 'Too many attempts. Wait a few minutes, then try again.',
  'error.code':
    'That code is not valid or has expired. Check it and try again.',
  'error.backupCode':
    'That backup code is not valid or has already been used. Check it and try again.',
  'error.network':
    'Could not reach the server. Check your connection and try again.',
  'error.server': 'Something went wrong on our side. Try again in a moment.',
  'error.passwordIncorrect': 'That password is not correct. Try again.',

  // Two-step sign-in set-up: confirm the password first
  'enrol.confirm.heading': 'Set up two-step sign-in',
  'enrol.confirm.body':
    'Your role signs in with a password and a code from an authenticator app. Confirm your password to set this up.',
  'enrol.confirm.submit': 'Continue',
  // ... then add the key to the authenticator app and prove it with a code
  'enrol.key.heading': 'Add this site to your authenticator app',
  'enrol.key.body':
    'In your authenticator app, add an account and enter this setup key. On a device that has the app, you can open the link instead.',
  'enrol.key.label': 'Setup key',
  'enrol.key.copy': 'Copy setup key',
  'enrol.key.copied': 'Setup key copied.',
  'enrol.key.link': 'Open in authenticator app',
  'enrol.key.codeHint': 'Enter the 6-digit code the app shows for this site.',
  'enrol.key.submit': 'Verify',
  // ... then save the backup codes
  'enrol.backup.heading': 'Save your backup codes',
  'enrol.backup.body':
    'Each code signs you in once if you lose your authenticator app. They are shown only now, so store them somewhere safe.',
  'enrol.backup.copy': 'Copy codes',
  'enrol.backup.copied': 'Backup codes copied.',
  'enrol.backup.submit': 'I have saved my codes',

  // Sidebar and rail
  'sidebar.fullWidth': 'Full width',
  'sidebar.exit': 'Exit edit mode',
  'sidebar.logOut': 'Log out',
  'sidebar.skipLink': 'Skip to page',
  'sidebar.readOnly': 'Your role can view this site but not edit pages.',

  // Landmarks
  'landmark.sidebar': 'Editor',
  'landmark.frame': 'Page being edited',

  // Frame states
  'frame.narrow.heading': 'Editing needs a wider window',
  'frame.narrow.body':
    'Make this window at least 1024 pixels wide to edit, or exit edit mode.',
  'frame.error.heading': 'This page could not be shown in edit mode',
  'frame.error.body':
    'Reload to try again. If it keeps happening, exit edit mode and check that the page loads for visitors.',
  'frame.error.reload': 'Reload page',

  // Overlay label for a block whose type is not available
  'overlay.unavailable': '{type} (unavailable)',

  // Login-to-edit transition
  'transition.opening': 'Opening the page',

  // Edit tools: mode, undo and redo, save status, lock countdown
  'tools.mode.label': 'Mode',
  'tools.mode.edit': 'Edit',
  'tools.mode.interact': 'Interact',
  'tools.mode.interactHint':
    "You're using the site as a visitor would. Switch to Edit to select and change things.",
  'tools.mode.railLabel': 'Interact mode',
  'tools.mode.railTooltip': 'Interact mode (I)',
  'tools.undo': 'Undo',
  'tools.redo': 'Redo',
  'save.saved': 'All changes saved',
  'save.saving': 'Saving',
  'save.failed': 'Could not save your changes',
  'save.paused': 'Saving is paused',
  'save.retry': 'Retry',
  'lock.expiring': 'Editing access ends in {time}',
  'lock.keepEditing': 'Keep editing',
  'lock.renewing': 'Renewing',

  // Announcements (visually hidden live region). `announce.needsInput` is
  // appended to a selection announcement, so it keeps its leading space.
  'announce.selected': 'Selected {label}, {position} of {total} in {parent}.',
  'announce.selectedSection':
    'Selected {label}, section {position} of {total}.',
  'announce.needsInput': ' Needs input.',
  'announce.editMode': 'Edit mode.',
  'announce.interactMode': 'Interact mode.',
  'announce.added': 'Added {label}.',
  'announce.moved':
    'Moved {label} to position {position} of {total} in {parent}.',
  'announce.restored': 'Restored {label}.',
  'announce.undone': 'Undone: {action}.',
  'announce.redone': 'Redone: {action}.',
  'announce.drag.pickedUp':
    'Picked up {label}. Use the arrow keys to choose a position, Space to drop, Escape to cancel.',
  'announce.drag.position': 'Position {position} of {total} in {parent}.',
  'announce.drag.dropped':
    'Dropped {label} at position {position} of {total} in {parent}.',
  'announce.drag.cancelled': 'Move cancelled.',

  // What an undo or redo announces it undid or redid
  'action.added': 'Added {label}',
  'action.moved': 'Moved {label}',
  'action.deleted': 'Deleted {label}',
  'action.duplicated': 'Duplicated {label}',
  'action.changed': 'Changed {property} of {label}',

  // Names for structure that has no label of its own
  'label.section': 'Section',
  'label.column': 'Column {n}',
  'label.page': 'Page',
  'kind.section': 'section',
  'kind.column': 'column',

  // Floating toolbar: tooltip, then the accessible name
  'toolbar.label': 'Actions for {label}',
  'toolbar.drag.tooltip': 'Drag to move',
  'toolbar.drag.label': 'Move {label}. Press Space to pick up.',
  'toolbar.moveLeft': 'Move left',
  'toolbar.moveLeft.label': 'Move {label} left',
  'toolbar.moveRight': 'Move right',
  'toolbar.moveRight.label': 'Move {label} right',
  'toolbar.moveUp': 'Move up',
  'toolbar.moveUp.label': 'Move {label} up',
  'toolbar.moveDown': 'Move down',
  'toolbar.moveDown.label': 'Move {label} down',
  'toolbar.addAfter': 'Add after',
  'toolbar.addAfter.label': 'Add after {label}',
  'toolbar.duplicate': 'Duplicate',
  'toolbar.duplicate.label': 'Duplicate {label}',
  'toolbar.properties': 'Properties',
  'toolbar.properties.label': 'Properties of {label}',
  'toolbar.delete': 'Delete',
  'toolbar.delete.label': 'Delete {label}',
  'toolbar.more': '…',
  'toolbar.more.label': 'Show the hidden levels',
  'toolbar.breadcrumb': 'Path to the selected item',
  'toolbar.reason.atStart': 'Already at the start',
  'toolbar.reason.atEnd': 'Already at the end',
  'toolbar.reason.lastColumn': 'A section needs at least one column.',
  'toolbar.reason.noDuplicate': "This can't be placed here a second time.",
  'toolbar.reason.noDeletePermission':
    "Your role can't delete content on this page.",

  // Insert points, picker, empty states
  'insert.blockAfter': 'Add block after {label}',
  'insert.blockHere': 'Add block here',
  'insert.section': 'Add section here',
  'insert.column': 'Add column here',
  'picker.block': 'Add a block',
  'picker.section': 'Add a section',
  'picker.search': 'Search blocks',
  'picker.other': 'Other',
  'picker.noMatch': 'No blocks match "{query}".',
  'picker.nothing.heading': 'Nothing can be added here',
  'picker.nothing.body':
    'The page structure does not allow another block in this spot.',
  'empty.column.add': 'Add block',
  'empty.page.heading': 'This page has no sections yet',
  'empty.page.body': 'Add a section to start building the page.',
  'empty.page.add': 'Add a section',

  // Delete confirmation, undo toast, leaving with unsaved changes
  'delete.heading': 'Delete this {kind}?',
  'delete.body.one': 'This removes 1 block inside it.',
  'delete.body.other': 'This removes {count} blocks inside it.',
  'delete.note': 'You can undo this right after.',
  'delete.cancel': 'Cancel',
  'delete.confirm': 'Delete {kind}',
  'toast.deleted': '{label} deleted',
  'toast.undo': 'Undo',
  'leave.heading': 'Leave without saving?',
  'leave.body': 'Your latest changes could not be saved.',
  'leave.stay': 'Stay',
  'leave.confirm': 'Leave anyway',

  // Side panel: tabs, empty states, Columns, Layout, Placement, controls
  'panel.tabs.label': 'Side panel',
  'panel.tab.blocks': 'Blocks',
  'panel.tab.properties': 'Properties',
  'panel.empty.heading': 'Nothing selected',
  'panel.empty.body': 'Select a block on the page to change its properties.',
  'panel.noProperties': 'This block has no properties.',
  'panel.unavailable':
    "This block's type is unavailable, so its properties can't be edited. You can move or delete it.",
  'panel.group.columns': 'Columns',
  'panel.group.layout': 'Layout',
  'panel.group.settings': 'Settings',
  'panel.group.placement': 'Placement',
  'panel.columnWidths': 'Column widths',
  'panel.columnsEqual': 'Columns are equal width.',
  'panel.columnAlignment': 'Column alignment',
  'panel.align.stretch': 'Stretch',
  'panel.align.start': 'Top',
  'panel.align.center': 'Center',
  'panel.align.end': 'Bottom',
  // Joins the terms of a column ratio into its name ("1 to 2"), so it keeps
  // its surrounding spaces.
  'panel.preset.separator': ' to ',
  'panel.column.empty': 'Empty',
  'panel.column.count.one': '1 block',
  'panel.column.count.other': '{count} blocks',
  'panel.addColumn': 'Add column',
  'panel.column.moveEarlier': 'Move {label} earlier',
  'panel.column.moveLater': 'Move {label} later',
  'panel.column.remove': 'Remove {label}',
  'panel.fill.label': 'Fill column height',
  'panel.fill.hint': 'Stretches this block to the full height of its column.',
  'panel.needsInput': 'Needs input',
  'panel.openSectionLayout': 'Open section layout',
  'panel.columnWidthNote': "Column width comes from the section's layout.",
  'panel.fixedHint': "Set by the site. It can't be changed here.",
  'panel.allowedHint': 'Allowed: {values}.',
  'panel.allowedError': 'Choose one of the allowed values.',
  'panel.slugHint': 'Lowercase letters, numbers and hyphens.',
  'panel.jsonError': 'Enter valid JSON.',
  'panel.invalid': 'This value is not valid.',
  'panel.richTextNote':
    'Formatted text is edited on the page. Editing it there arrives in the next release.',
  'panel.mediaNote':
    'Choosing a file is available once the media library ships.',
  'panel.entryNote': 'Choosing an entry is available once entry editing ships.',
  'panel.customWidgetNote':
    'This property uses a custom control the editor does not have yet, so a standard field stands in for it.',
  'panel.customWidgetJsonNote':
    'This property uses a custom control the editor does not have yet. Enter its value as JSON.',
  'panel.jsonFallbackHint':
    'Write text in straight double quotes ("like this"), numbers and true or false as they are, a list as [ ] and a group of values as { }.',
  'panel.jsonFallbackError':
    'This is not valid JSON. Put text in straight double quotes, like "red".',
  'panel.none': 'None',
  'panel.repeater.add': 'Add item',
  'panel.repeater.moveEarlier': 'Move item {n} earlier',
  'panel.repeater.moveLater': 'Move item {n} later',
  'panel.repeater.remove': 'Remove item {n}',
  'panel.palette.selectFirst': 'Select a place on the page first',
  'panel.palette.notHere': "Can't be added here",

  // Page lock, conflict and session notices
  'notice.locked.heading': '{name} is editing this page',
  'notice.locked.body':
    'Last active {time}. You can look around. This page opens for editing automatically when they are done.',
  'notice.locked.takeOver': 'Take over',
  'notice.lapsed': '{name} stopped editing. You can edit this page now.',
  'notice.takenOver.heading': '{name} took over this page',
  'notice.takenOver.body':
    'Changes that were not saved yet were discarded. The page now shows the latest saved version.',
  'notice.stale.heading': 'This page changed elsewhere',
  'notice.stale.body':
    'It was edited in another tab or window. Reload to continue with the latest version.',
  'notice.stale.reload': 'Reload page',
  'notice.session.heading': 'Your session ended',
  'notice.session.body':
    'Sign in again to keep editing. Your saved changes are kept.',
  'notice.session.signIn': 'Sign in',
  'notice.retryFailed': "That didn't work. Try again.",
  'takeover.heading': 'Take over editing?',
  'takeover.body':
    '{name} will lose editing access to this page. Everything they already saved is kept.',
  'takeover.cancel': 'Cancel',
  'takeover.confirm': 'Take over',
  'takeover.inFlight': 'Taking over',

  // The page region in Edit mode, and the rail's panel buttons
  'landmark.editRegion': 'Page being edited',
  'rail.blocks': 'Blocks',
  'rail.properties': 'Properties',
  'rail.notice': 'Page status',
  'rail.withNotice': '{label}, new notice',
  'rail.drawer': 'Blocks and properties',
});

/** A key of `STRINGS`. */
export type StringKey = keyof typeof STRINGS;

/** The names of the `{name}` placeholders in a string literal type. */
type Placeholders<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | Placeholders<Rest>
    : never;

type VariablesOf<K extends StringKey> = Placeholders<(typeof STRINGS)[K]>;

type FormatArguments<K extends StringKey> = [VariablesOf<K>] extends [never]
  ? []
  : [variables: Readonly<Record<VariablesOf<K>, string>>];

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The string for a key with its `{name}` placeholders replaced. Replacement
 * is one pass over the template, so a variable's value is never interpolated
 * again, and nothing is escaped: React escapes text when it renders.
 */
export function formatString<K extends StringKey>(
  key: K,
  ...args: FormatArguments<K>
): string {
  const variables: Readonly<Record<string, string>> = args[0] ?? {};
  return STRINGS[key].replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    return value ?? placeholder;
  });
}
