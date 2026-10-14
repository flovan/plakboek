---
'@plakboek/editor': minor
---

Locks and conflicts on the page. A page another editor holds opens as the read-only shell with a banner naming who is editing and when they were last active, and opens for editing by itself once they are done. An editor whose permissions cover the holder's can take the page over after a confirmation, and an editor who is taken over is told, made read-only and loses nothing that was saved. A write from a second tab of the same editor pauses saving with a Reload page button, an ended session offers Sign in, and a lock that cannot be renewed shows when editing access ends with a Keep editing button. Exit edit mode and Log out save what is pending first and ask before leaving if saving failed, and closing the tab with unsaved changes raises the browser's own prompt.
