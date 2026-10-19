package com.autoatc.radio

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** One station on the hub's list (monitor/radio.js 'stations'). */
data class Station(val freq: String, val station: String, val callsign: String, val human: Boolean, val controller: String?)

/**
 * The connection to the monitor's radio hub (monitor/radio.js, /radio) - the same protocol as the PC companion's
 * renderer/radio.js: JSON text frames for control, binary frames for audio (16 kHz mono 16-bit PCM; incoming frames
 * carry a 2-byte stream id first). Reconnects by itself. Callbacks arrive on the main thread.
 */
class RadioClient(private val listener: Listener) {
    interface Listener {
        fun onStatus(state: String)
        fun onStations(stations: List<Station>)
        fun onPtt(granted: Boolean, freq: String?, reason: String?)
        fun onRxStart(stream: Int, freq: String, from: String)
        fun onRxAudio(stream: Int, pcm: ByteArray)
        fun onRxEnd(stream: Int)
        fun onText(freq: String, from: String?, text: String)
        fun onClip(freq: String, from: String, text: String, mp3: ByteArray?)
    }

    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var url: String? = null
    private var wanted = false
    private var retryMs = 2000L
    @Volatile var connected = false
        private set
    private var tx: String? = null
    private var rx: List<String> = emptyList()

    fun connect(server: String, callsign: String) {
        val base = server.trim().trimEnd('/').replaceFirst(Regex("^http"), "ws")
        val next = "$base/radio?callsign=${URLEncoder.encode(callsign.ifBlank { "UNKNOWN" }, "UTF-8")}"
        if (wanted && next == url && ws != null) return
        disconnect()
        url = next
        wanted = true
        open()
    }

    fun disconnect() {
        wanted = false
        ws?.close(1000, "bye")
        ws = null
        connected = false
    }

    private fun open() {
        val target = url ?: return
        if (!wanted) return
        main.post { listener.onStatus("connecting") }
        ws = http.newWebSocket(Request.Builder().url(target).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected = true
                retryMs = 2000L
                sendTune()
                main.post { listener.onStatus("connected") }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try { JSONObject(text) } catch (e: Exception) { return }
                main.post { onJson(msg) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (bytes.size < 2) return
                val raw = bytes.toByteArray()
                val stream = (raw[0].toInt() and 0xff) or ((raw[1].toInt() and 0xff) shl 8)
                listener.onRxAudio(stream, raw.copyOfRange(2, raw.size)) // audio stays off the main thread
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
        })
    }

    private fun dropped(socket: WebSocket) {
        if (socket !== ws) return
        connected = false
        ws = null
        if (!wanted) { main.post { listener.onStatus("off") }; return }
        main.post { listener.onStatus("reconnecting") }
        main.postDelayed({ if (wanted && ws == null) open() }, retryMs)
        retryMs = (retryMs * 2).coerceAtMost(30_000L)
    }

    private fun onJson(msg: JSONObject) {
        when (msg.optString("type")) {
            "hello", "stations" -> listener.onStations(parseStations(msg.optJSONArray("stations")))
            "ptt" -> listener.onPtt(msg.optBoolean("granted"), msg.optString("freq").ifBlank { null }, msg.optString("reason").ifBlank { null })
            "rx-start" -> listener.onRxStart(msg.optInt("stream"), msg.optString("freq"), msg.optString("from"))
            "rx-end" -> listener.onRxEnd(msg.optInt("stream"))
            "rx-text" -> listener.onText(msg.optString("freq"), msg.optString("from").ifBlank { null }, msg.optString("text"))
            "rx-clip" -> {
                val audio = msg.optString("audio")
                val mp3 = if (audio.isNotBlank()) android.util.Base64.decode(audio, android.util.Base64.DEFAULT) else null
                listener.onClip(msg.optString("freq"), msg.optString("from"), msg.optString("text"), mp3)
            }
        }
    }

    private fun parseStations(arr: JSONArray?): List<Station> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Station(
                freq = o.optString("freq"),
                station = o.optString("station"),
                callsign = o.optString("callsign"),
                human = o.optString("staffed") == "human",
                controller = o.optString("controller").ifBlank { null },
            )
        }
    }

    /** Transmit frequency (or null) and the ones to listen to. */
    fun tune(tx: String?, rx: List<String>) {
        this.tx = tx
        this.rx = rx
        sendTune()
    }

    private fun sendTune() {
        val msg = JSONObject().put("type", "tune").put("tx", tx ?: JSONObject.NULL).put("rx", JSONArray((rx + listOfNotNull(tx)).distinct()))
        ws?.send(msg.toString())
    }

    fun ptt(on: Boolean) { ws?.send(JSONObject().put("type", "ptt").put("on", on).toString()) }

    fun sendAudio(pcm: ByteArray, length: Int) { ws?.send(pcm.toByteString(0, length)) }
}
