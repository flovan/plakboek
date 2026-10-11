---
'@plakboek/editor': minor
---

A superadmin, or any role that must use two-step sign-in, can now set it up inside the login modal at `/cms/two-factor/enrol`. The card asks for the password again, then shows the setup key in groups of four with a button to copy it and an `otpauth://` link that opens the authenticator app (no QR code), checks the first six-digit code, shows the backup codes once with a copy button, and hands over to the edit shell. A wrong password or a wrong code shows its message and keeps the step; five wrong codes end on the lockout step. The key and the backup codes exist only in the card's state while the step is on screen: they are never put in the address, the page data, the browser's storage or the console, and reloading the step starts it again. The gate is unchanged: until the first code is accepted, edit mode still redirects to the set-up. Once a key is confirmed, asking for another is refused by the auth service.
