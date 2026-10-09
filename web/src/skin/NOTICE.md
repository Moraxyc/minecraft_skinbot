# Preview label masks

The fixed `Front`, `Side`, and `Back` masks in `tgcloud/lib/skin/labels.js` use Aileron Regular
from [DOT COLON](https://dotcolon.net/fonts/aileron/). The font author declares
“No Rights Reserved” and permits modification and redistribution.

The masks use Pillow 12.3.0's default Aileron subset, FreeType 2.14.3,
22-pixel text, and the `mm` anchor. Each mask stores 8-bit coverage values;
the renderer supplies its color. No font software is included at runtime.
