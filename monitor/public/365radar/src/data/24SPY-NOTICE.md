# 24SPY data notice

`spy24Data.js` in this folder contains waypoints, airways and FIR/TMA
airspace outlines taken from **24SPY**:

- Source: https://github.com/tiaguinho2009/24SPY
- Original work by **Tiago Murteira (nickname: tiaguinho_2009)**
- Taken from the repository as of the commit recorded in the
  `sourceCommit` field of `spy24Data.js`.

**This is a modified copy.** The positions were converted from 24SPY's map
units to this radar's world-map.png pixel space by a fitted similarity
transform (see `scripts/import-24spy.js`, and the `fit` field in
`spy24Data.js` for how closely the two maps agree); airways were resolved
to coordinates; and only waypoints, airways and FIR/TMA outlines were
taken. Nothing else was changed.

It is kept in a file of its own, apart from `fixes.js` and
`worldMapAnchors.js` (which derive from 24Radar, GPLv3), because the 24SPY
licence below is not GPL-compatible. **Use of this data is non-commercial
only**, so this radar must not be sold or used to earn money or other
commercial gain.

## The 24SPY licence, in full

# 24SPY License

Copyright (c) 2025 Tiago Murteira (nickname: tiaguinho_2009)

Permission is hereby granted to any person obtaining a copy of this software and associated documentation files (the "Software"), to use, modify, and redistribute the Software, under the following conditions:

1. **Attribution**: Users must give appropriate credit, provide a link to the original source, and indicate if changes were made. Attribution must clearly state that the original work was created by Tiago Murteira (nickname: tiaguinho_2009).

2. **Non-Commercial Use**: The Software may not be used, modified, or redistributed for commercial purposes. Commercial use includes, but is not limited to, using the Software in a product or service that is sold, offered for sale, or used to generate revenue or commercial gain.

3. **Redistribution and Modifications**:
   - Users are allowed to modify and distribute copies of the Software as long as these copies are not used for commercial purposes.
   - All modified versions of the Software must include a prominent notice that they have been altered from the original, with a clear indication of the changes made.

4. **No Warranty**: This Software is provided "as-is," without any express or implied warranty. In no event shall the author be held liable for any damages arising from the use or inability to use this Software.

By using, modifying, or redistributing the Software, users agree to abide by these terms.
