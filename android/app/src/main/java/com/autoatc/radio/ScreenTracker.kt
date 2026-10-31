package com.autoatc.radio

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.WindowManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/**
 * Radar tracking from the screen (the pilot allowed screen sharing): about once a second it takes a screenshot of
 * the game and sends it to the server (monitor /api/phone-frame), which reads the aircraft's position off the PTFS
 * minimap the way the PC companion does and puts it on the radar. First a whole-screen picture to find the minimap,
 * then only the minimap, cropped at full resolution (~10 KB a second).
 */
class ScreenTracker(context: Context, private val projection: MediaProjection, private val prefs: Prefs) {
    companion object {
        private const val INTERVAL_MS = 1000L
        private const val FULL_WIDTH = 1280
    }

    private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private val thread = HandlerThread("screen-tracker").apply { start() }
    private val bg = Handler(thread.looper)
    private val width: Int
    private val height: Int
    private val reader: ImageReader
    private var display: VirtualDisplay? = null
    @Volatile private var running = false

    // where the minimap is, as fractions of the screen (from the server)
    private var minimap: FloatArray? = null
    private var misses = 0
    private var lastFullAt = 0L

    init {
        // PTFS plays in landscape: mirror the screen into a landscape picture whatever way the phone is held now
        val wm = context.getSystemService(WindowManager::class.java)
        val (w, h) = if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.maximumWindowMetrics.bounds; b.width() to b.height()
        } else {
            val m = context.resources.displayMetrics; m.widthPixels to m.heightPixels
        }
        width = maxOf(w, h)
        height = minOf(w, h)
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        if (Build.VERSION.SDK_INT >= 34) {
            projection.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() { main.post { stop("Screen sharing stopped") } }
            }, main)
        }
        display = projection.createVirtualDisplay("autoatc-radar", width, height, context.resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.surface, null, bg)
    }

    fun start() {
        running = true
        status("Radar tracking: looking for the minimap…")
        bg.postDelayed(tick, INTERVAL_MS)
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            try { step() } catch (e: Exception) { status("Radar tracking: ${e.message ?: "error"}") }
            if (running) bg.postDelayed(this, INTERVAL_MS)
        }
    }

    private fun grab(): Bitmap? {
        val image = reader.acquireLatestImage() ?: return null
        image.use {
            val plane = it.planes[0]
            val rowPixels = plane.rowStride / plane.pixelStride
            val padded = Bitmap.createBitmap(rowPixels, it.height, Bitmap.Config.ARGB_8888)
            padded.copyPixelsFromBuffer(plane.buffer)
            if (rowPixels == it.width) return padded
            return Bitmap.createBitmap(padded, 0, 0, it.width, it.height).also { padded.recycle() }
        }
    }

    private fun jpeg(b: Bitmap, quality: Int): ByteArray = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()

    private fun post(kind: String, body: ByteArray): JSONObject? {
        val base = prefs.server.trim().trimEnd('/')
        val callsign = java.net.URLEncoder.encode(prefs.callsign.ifBlank { "UNKNOWN" }, "UTF-8")
        val req = Request.Builder().url("$base/api/phone-frame?callsign=$callsign&kind=$kind")
            .post(body.toRequestBody("image/jpeg".toMediaType())).build()
        http.newCall(req).execute().use { r ->
            val text = r.body?.string() ?: return null
            return try { JSONObject(text) } catch (e: Exception) { null }
        }
    }

    private fun step() {
        val shot = grab() ?: return
        try {
            val m = minimap
            if (m == null) {
                // look for the minimap at most every 3 s (whole screen, shrunk)
                if (System.currentTimeMillis() - lastFullAt < 3000) return
                lastFullAt = System.currentTimeMillis()
                val s = minOf(1f, FULL_WIDTH.toFloat() / shot.width)
                val small = Bitmap.createScaledBitmap(shot, (shot.width * s).toInt(), (shot.height * s).toInt(), true)
                val res = post("full", jpeg(small, 70))
                small.recycle()
                val r = res?.optJSONObject("minimap")
                if (res?.optBoolean("ok") == true && r != null) {
                    minimap = floatArrayOf(r.optDouble("x").toFloat(), r.optDouble("y").toFloat(), r.optDouble("w").toFloat(), r.optDouble("h").toFloat())
                    misses = 0
                    status("Radar tracking: minimap found")
                } else {
                    status("Radar tracking: open PTFS with the minimap showing")
                }
                return
            }
            val x = (m[0] * shot.width).toInt().coerceIn(0, shot.width - 2)
            val y = (m[1] * shot.height).toInt().coerceIn(0, shot.height - 2)
            val w = (m[2] * shot.width).toInt().coerceIn(1, shot.width - x)
            val h = (m[3] * shot.height).toInt().coerceIn(1, shot.height - y)
            val crop = Bitmap.createBitmap(shot, x, y, w, h)
            val res = post("mini", jpeg(crop, 80))
            crop.recycle()
            when {
                res == null -> status("Radar tracking: server not answering")
                res.optBoolean("ok") -> {
                    misses = 0
                    val p = res.optJSONObject("position")
                    if (p != null) status("On radar: ${"%.1f".format(p.optDouble("distanceNm"))} nm from ${p.optString("referenceAirport")}")
                }
                res.optBoolean("noMarker") -> {
                    // the minimap moved, closed or the game isn't on screen: after a few misses, look for it again
                    if (++misses >= 5) { minimap = null; misses = 0; status("Radar tracking: lost the minimap, looking again…") }
                }
                else -> { /* a weak or ignored fix: keep the last position */ }
            }
        } finally {
            shot.recycle()
        }
    }

    private fun status(text: String) = main.post { RadioState.track = text; RadioState.changed() }

    fun stop(reason: String = "Radar tracking off") {
        if (!running && display == null) return
        running = false
        bg.removeCallbacks(tick)
        try { display?.release() } catch (_: Exception) {}
        display = null
        try { projection.stop() } catch (_: Exception) {}
        bg.post { try { reader.close() } catch (_: Exception) {}; thread.quitSafely() }
        RadioState.track = reason
        RadioState.trackingOn = false
        RadioState.changed()
    }
}
