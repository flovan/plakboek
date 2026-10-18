---
'@plakboek/editor': patch
---

A property with a custom control the editor does not have is now edited with the standard control of its field type, for example a text input for a short text, with a note that a standard field stands in for it. The JSON field that used to stand in for every such property is now only for custom field types. It explains what to type: text in straight double quotes, numbers and true or false as they are, lists and groups as JSON. It also reads the curly quotes a system may substitute as straight ones, and tells a valid JSON value the property does not accept apart from text that is not JSON.
