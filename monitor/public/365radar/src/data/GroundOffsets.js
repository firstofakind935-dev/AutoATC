export default{
    "IBLT": { zoom: 0.00885905028317445, x: -116.75703430175781, y: 171.21368408203125, r: 76.1 },
    "IBTH": { zoom: 0.009168518271158612, x: 53.03730392456055, y: -49.046810150146484, r: 0 },
    "IDCS": { zoom: 0.005328434886425653, x: -51.60231018066406, y: -451.76800537109375, r: 17.1 },
    "IGAR": { zoom: 0.01828148221365163, x: -172.20089721679688, y: 228.84181213378906, r: 47.9 },
    "IGRV": { zoom: 0.016277857551922525, x: -439.2790222167969, y: -35.30495071411133, r: 28 },
    "IHEN": { zoom: 0.010776910838944359, x: 167.116455078125, y: 408.3504638671875, r: 98 },
    "IIAB": { zoom: 0.033138356715857346, x: 215.12513732910156, y: 387.8442687988281, r: 174.9 },
    "IJAF": { zoom: 0.014181553593891434, x: 454.5016784667969, y: -4.410373687744141, r: 199.1 },
    "ILAR": { zoom: 0.024471305840817078, x: 202.70550537109375, y: 316.3956604003906, r: 26.1 },
    "ILKL": { zoom: 0.008610120859527962, x: 221.50294494628906, y: -169.2882537841797, r: 1.1 },
    "IMLR": { zoom: 0.01938817624446287, x: -203.56814575195312, y: 139.2357635498047, r: 204 },
    "IPAP": { zoom: 0.02320169571725877, x: 305.925048828125, y: 332.0542907714844, r: 96 },
    "IPPH": { zoom: 0.032138398842918615, x: 163.88230895996094, y: -218.7863006591797, r: 339 },
    "IRFD": { zoom: 0.033574469940895024, x: -40.28365707397461, y: 192.385498046875, r: 23 },
    "ISAU": { zoom: 0.014645149883030638, x: -467.80902099609375, y: 270.468505859375, r: 3.7 },
    "ISCM": { zoom: 0.014260183424544408, x: 354.0067138671875, y: -56.652061462402344, r: 143.8 },
    "ISKP": { zoom: 0.0038448804221858784, x: 252.87281799316406, y: 130.21929931640625, r: 39 },
    "ITKO": { zoom: 0.0464185210966416, x: -102.52693939208984, y: -347.13507080078125, r: 321.9 },
    "ITRC": { zoom: 0.008462788347527199, x: -24.186115264892578, y: 299.1365051269531, r: 89.7 },
    "IZOL": { zoom: 0.028884832385422086, x: 432.1466369628906, y: 23.684097290039062, r: 344 },

    // --- AutoATC additions below: 24radar has no real ground-view offset for
    // these (no GROUND.svg exists for them either, so the GND button will
    // fail gracefully). Position is an ESTIMATE fitted from AutoATC's own
    // approximate lat/lon against the airports above, not a measured value -
    // treat placement of aircraft referencing these airports on the enroute
    // map as rough, not precise. zoom/r are placeholder defaults.
    "IBAR": { zoom: 0.01, x: 251.2702, y: 272.0383, r: 0 },
    "IBRD": { zoom: 0.01, x: -61.6464, y: -233.9458, r: 0 },
    "IGCG": { zoom: 0.0535, x: -349.6831, y: -99.0152, r: 0 },
    // IKFL's zoom is measured, not estimated like its siblings here - the
    // ground SVGs aren't drawn to a shared real-world scale (confirmed:
    // IKFL's chart is ~6.7x denser per real nm than IRFD's), so a uniform
    // zoom across airports makes smaller-chart-scale airports look
    // over-zoomed relative to others (the original "Keflavik 2x oversized"
    // bug). Recalibrated against real in-game measurements (IKFL 0.7x0.9nm,
    // IRFD 6.1x6.8nm - IRFD's own zoom kept as the fixed anchor) so
    // container-width-in-real-nm is consistent between the two: measured
    // each SVG's own getBBox() in a real browser, then solved
    // zoom = (IRFD.zoom * IRFD.realWidthNm) / IKFL.realWidthNm. The other
    // airports here still use IRFD's un-recalibrated scale and may have
    // the same relative-size issue - fix them the same way once real
    // measurements are available for them too.
    "IKFL": { zoom: 0.253674, x: -378.5900, y: -60.2400, r: 0 },
    "ITEY": { zoom: 0.0415, x: -356.1399, y: -72.5132, r: 0 },
    "IUFO": { zoom: 0.01, x: 96.7315, y: -85.7401, r: 0 },
    "SHV": { zoom: 0.01, x: 225.4261, y: -201.4141, r: 0 },
    "TVO": { zoom: 0.0211, x: -349.6831, y: -88.8962, r: 0 }
}