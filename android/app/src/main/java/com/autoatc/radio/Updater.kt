package com.autoatc.radio

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Updates from GitHub: every APK build replaces the `android-latest` release, named "... (build N)" where N is the
 * build's versionCode (.github/workflows/build-apk.yml). If N is newer than this app, the APK is downloaded and handed
 * to Android's installer - Android always asks the pilot to confirm (one tap), there's no silent install outside
 * the Play Store. Updates only install over the old app when both are signed with the same key (see README).
 */
object Updater {
    const val RELEASE_API = "https://api.github.com/repos/firstofakind935-dev/AutoATC/releases/tags/android-latest"
    const val ACTION_INSTALL_STATUS = "com.autoatc.radio.INSTALL_STATUS"

    data class Update(val build: Long, val apkUrl: String)

    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())

    fun installedBuild(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }

    /** Looks for a newer build (off the main thread); `done` gets it on the main thread, or null. */
    fun check(context: Context, done: (Update?) -> Unit) {
        val app = context.applicationContext
        Thread {
            val found = try {
                http.newCall(Request.Builder().url(RELEASE_API).header("Accept", "application/vnd.github+json").build()).execute().use { r ->
                    if (!r.isSuccessful) null else {
                        val rel = JSONObject(r.body!!.string())
                        val build = Regex("""build (\d+)""").find(rel.optString("name"))?.groupValues?.get(1)?.toLongOrNull()
                        val assets = rel.optJSONArray("assets")
                        val apk = (0 until (assets?.length() ?: 0)).map { assets!!.getJSONObject(it) }
                            .firstOrNull { it.optString("name").endsWith(".apk") }?.optString("browser_download_url")
                        if (build != null && apk != null && build > installedBuild(app)) Update(build, apk) else null
                    }
                }
            } catch (e: Exception) { null }
            main.post { done(found) }
        }.apply { name = "update-check"; start() }
    }

    /** Downloads the APK and asks Android to install it; `progress` gets status lines on the main thread. */
    fun install(activity: Activity, update: Update, progress: (String) -> Unit) {
        val app = activity.applicationContext
        progress("Downloading build ${update.build}…")
        Thread {
            try {
                val installer = app.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                val sessionId = installer.createSession(params)
                installer.openSession(sessionId).use { session ->
                    http.newCall(Request.Builder().url(update.apkUrl).build()).execute().use { r ->
                        if (!r.isSuccessful) throw IllegalStateException("download failed (${r.code})")
                        session.openWrite("AutoATC-Radio.apk", 0, -1).use { out ->
                            r.body!!.byteStream().copyTo(out)
                            session.fsync(out)
                        }
                    }
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    val status = PendingIntent.getActivity(app, 7, Intent(app, MainActivity::class.java).setAction(ACTION_INSTALL_STATUS), flags)
                    session.commit(status.intentSender)
                }
                main.post { progress("Tap Install to update.") }
            } catch (e: Exception) {
                main.post { progress("Update failed: ${e.message}") }
            }
        }.apply { name = "update-install"; start() }
    }

    /** Handles the installer's answer (MainActivity.onNewIntent); returns a line for the log, or null. */
    fun onInstallStatus(activity: Activity, intent: Intent): String? {
        if (intent.action != ACTION_INSTALL_STATUS) return null
        return when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                confirm?.let { activity.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                null
            }
            PackageInstaller.STATUS_SUCCESS -> "Updated."
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                "!! Update can't install over this copy (it was signed differently). Uninstall AutoATC Radio once, then install the new APK from the download link."
            else -> "!! Update failed: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown error"}"
        }
    }
}
