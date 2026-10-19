package com.autoatc.radio

import android.content.Context
import android.content.SharedPreferences

/** Saved settings. */
class Prefs(context: Context) {
    private val p: SharedPreferences = context.getSharedPreferences("radio", Context.MODE_PRIVATE)
    var callsign: String
        get() = p.getString("callsign", "") ?: ""
        set(v) = p.edit().putString("callsign", v).apply()
    var server: String
        get() = p.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(v) = p.edit().putString("server", v).apply()
    /** COM1: transmit and listen. */
    var com1: String?
        get() = p.getString("com1", null)
        set(v) = p.edit().putString("com1", v).apply()
    /** COM2: listen only, or null when off. */
    var com2: String?
        get() = p.getString("com2", null)
        set(v) = p.edit().putString("com2", v).apply()
    var volume: Float
        get() = p.getFloat("volume", 1f)
        set(v) = p.edit().putFloat("volume", v).apply()
    var bubbleX: Int
        get() = p.getInt("bubbleX", 24)
        set(v) = p.edit().putInt("bubbleX", v).apply()
    var bubbleY: Int
        get() = p.getInt("bubbleY", 320)
        set(v) = p.edit().putInt("bubbleY", v).apply()

    companion object {
        const val DEFAULT_SERVER = "https://cpdlc.up.railway.app"
    }
}

/**
 * What the radio is doing, shared by the service, the floating button and the app screen (one process; everything
 * here is touched on the main thread only).
 */
object RadioState {
    enum class Tx { IDLE, KEYING, TRANSMITTING }

    var running = false
    var status = "off"
    var stations: List<Station> = emptyList()
    var tx = Tx.IDLE
    var lastAtc: String? = null
    val log = ArrayDeque<String>()

    private val listeners = mutableListOf<() -> Unit>()
    fun listen(l: () -> Unit) { listeners.add(l) }
    fun unlisten(l: () -> Unit) { listeners.remove(l) }
    fun changed() { listeners.toList().forEach { it() } }

    fun addLog(line: String) {
        val t = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
        log.addLast("$t  $line")
        while (log.size > 60) log.removeFirst()
        changed()
    }

    fun stationOn(freq: String?): Station? = stations.firstOrNull { it.freq == freq }
}
