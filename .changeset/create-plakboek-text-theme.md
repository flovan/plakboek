---
'create-plakboek': minor
---

The starter now ships a text theme (`text-theme.tsx`) and two new blocks: a Text block with in-place rich text and a Button block that renders through the theme's call-to-action renderer. The Heading block offers Title, Heading and Subheading (`h2` to `h4`) and no `h1`, the site name in the header is the page's single `h1`, and the token block in `app/app.css` is `@theme static` so stored colour and size tokens always exist in the built stylesheet. The README explains the theme, narrowing, renderer overrides and the inline styles that custom values and alignment need under a strict `style-src`.
