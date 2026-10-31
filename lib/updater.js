// Automatic updates for the installed app (Windows): checks GitHub at start-up and every 30 minutes, downloads a
// new version in the background and installs it when the app closes - or straight away if the pilot presses
// "Restart to update". New versions come from .github/workflows/build-installer.yml, which publishes the installer
// and latest.yml (version + checksum) as the latest release on every push to companion-app.
const CHECK_EVERY_MS = 30 * 60 * 1000;

function startAutoUpdates({ app, onReady, log = console }) {
  if (!app.isPackaged) return null; // running from source (npm start): nothing to update
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log.warn('auto-update unavailable:', err.message);
    return null;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // every release is served from the same /releases/latest/download/ URL, so a differential download would compare
  // the new installer with itself: always fetch the whole (small) installer
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = null;
  let ready = null;
  autoUpdater.on('update-downloaded', (info) => { ready = info.version; onReady(info.version); });
  autoUpdater.on('error', (err) => log.warn('update check failed:', err && err.message));
  const check = () => autoUpdater.checkForUpdates().catch((err) => log.warn('update check failed:', err.message));
  setTimeout(check, 15 * 1000);
  setInterval(check, CHECK_EVERY_MS).unref();
  return {
    readyVersion: () => ready,
    installNow() { if (ready) autoUpdater.quitAndInstall(true, true); }, // silent install, then reopen the app
  };
}

module.exports = { startAutoUpdates };
