# Build with: pyinstaller build.spec
# Produces dist/PTFSTracker.exe (single file, no console window)

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=['../src'],
    binaries=[],
    datas=[('style.qss', '.'), ('version.txt', '.'), ('icon.ico', '.'),
           ('../src/reference_map.png', '.'), ('../src/world_anchors.json', '.')],
    hiddenimports=[
        'app_config',
        'webhook',
        'broadcast_server',
        'marker_finder',
        'map_locator',
        'monitor_client',
        'reference_registration',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=['config'],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='PTFSTracker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,   # no terminal window behind the GUI
    icon='icon.ico',       # put an .ico path here once you have one, e.g. 'icon.ico'
)
