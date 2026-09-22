export default {
  "image": "world-map.png",
  "imageWidth": 937,
  "imageHeight": 706,
  "pxPerNm": 24.0,
  "studsPerNm": 3307.14286,
  "note": "x/y are pixel coordinates on world-map.png. confidence: direct = pixel-measured from the image itself; derived-from-X = offset from a direct anchor using existing relative stud spacing; fitted-only = predicted from a global least-squares transform fit to 8 trusted native anchors (residuals up to ~45px seen on those 8 points, so treat as a rough first pass, not verified against the image).",
  "anchors": {
    "IRFD": {
      "x": 503,
      "y": 513,
      "confidence": "direct (visible runway/taxiway pattern identified in the image)"
    },
    "IMLR": {
      "x": 377,
      "y": 448,
      "confidence": "direct"
    },
    "IPPH": {
      "x": 684,
      "y": 228,
      "confidence": "direct"
    },
    "IZOL": {
      "x": 825,
      "y": 362,
      "confidence": "direct"
    },
    "IBTH": {
      "x": 571,
      "y": 325,
      "confidence": "direct"
    },
    "ISAU": {
      "x": 170,
      "y": 520,
      "confidence": "direct-approx"
    },
    "ISKP": {
      "x": 710,
      "y": 460,
      "confidence": "direct-approx"
    },
    "ILAR": {
      "x": 678,
      "y": 595,
      "confidence": "direct (visible runway/taxiway pattern identified in the image)"
    },
    "IPAP": {
      "x": 754,
      "y": 606,
      "confidence": "derived-from-ILAR"
    },
    "IKFL": {
      "x": 204,
      "y": 342,
      "confidence": "direct (visible runway/taxiway pattern identified in the image)"
    },
    "ITEY": {
      "x": 221,
      "y": 333,
      "confidence": "derived-from-IKFL"
    },
    "IGCG": {
      "x": 228,
      "y": 315,
      "confidence": "derived-from-IKFL"
    },
    "TVO": {
      "x": 227,
      "y": 322,
      "confidence": "derived-from-IKFL"
    },
    "IUFO": {
      "x": 603,
      "y": 299,
      "confidence": "derived-from-IBTH"
    },
    "IGRV": {
      "x": 206,
      "y": 317,
      "confidence": "fitted-only"
    },
    "IBLT": {
      "x": 433,
      "y": 479,
      "confidence": "fitted-only"
    },
    "IDCS": {
      "x": 513,
      "y": 25,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "IGAR": {
      "x": 397,
      "y": 527,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "IHEN": {
      "x": 632,
      "y": 665,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "IIAB": {
      "x": 666,
      "y": 649,
      "confidence": "fitted-only"
    },
    "IJAF": {
      "x": 860,
      "y": 380,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "ILKL": {
      "x": 703,
      "y": 247,
      "confidence": "fitted-only"
    },
    "ISCM": {
      "x": 792,
      "y": 330,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "ITKO": {
      "x": 456,
      "y": 115,
      "confidence": "direct (visible runway/taxiway pattern identified in the image)"
    },
    "ITRC": {
      "x": 495,
      "y": 573,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "IBAR": {
      "x": 706,
      "y": 574,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "IBRD": {
      "x": 460,
      "y": 151,
      "confidence": "fitted-only, snapped onto nearest landmass (no unambiguous runway visible at this image resolution)"
    },
    "SHV": {
      "x": 708,
      "y": 224,
      "confidence": "fitted-only"
    }
  }
};
