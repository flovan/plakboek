---
'@plakboek/editor': minor
---

Every emailed-link step of the sign-in modal now works. "Forgot your password?" and "Email me a sign-in link" open request steps that answer with one "Check your email" state whether or not the address has an account, keep the page the editor came from, and show "Too many attempts" when the server rate limits. The invitation and reset links land on their modal step, take the token out of the address bar and the browser history as soon as the page loads, set the new password through the single-use flow and return to sign-in with a status line. A sign-in link lands on "Signing you in" and runs the same hand-over into edit mode as a password sign-in. Expired, used and malformed links share one "This link is no longer valid" step whose button leads to the request that can replace the link. The sign-in-link step says that accounts using an authenticator app cannot use sign-in links, without saying anything about a given address.
