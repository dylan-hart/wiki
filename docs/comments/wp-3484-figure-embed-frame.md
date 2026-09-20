# WP 3484: blocks/shared/figure.js

`embedFrameStyles` was deleted. Its leading JSDoc block was left in place because comments are not
edited directly.

**Recommended change:** delete the orphaned JSDoc block that begins "The frame an embedded player or
document is drawn in" (immediately above the JSDoc for `explainSourceFailure`). It documents an
export that no longer exists, and its TODO ("no block adopts either class yet") is moot with the
code gone. Nothing true remains in it.
