package com.autoatc.radio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.provider.Settings

/**
 * Keeps the radio running while the game is in front: a foreground service (microphone + playback), holding the
 * hub connection, the audio and the floating push-to-talk button. Started and stopped from MainActivity or the
 * notification's Stop button.
 */
class RadioService : Service(), RadioClient.Listener {
    companion object {
        const val ACTION_START = "com.autoatc.radio.START"
        const val ACTION_STOP = "com.autoatc.radio.STOP"
        private const val CHANNEL = "radio"
        private const val NOTIFICATION_ID = 1

        var instance: RadioService? = null
            private set

        fun start(context: Context) {
            val i = Intent(context, RadioService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, RadioService::class.java).setAction(ACTION_STOP))
        }
    }

    private lateinit var prefs: Prefs
    private var client: RadioClient? = null
    private var audio: AudioEngine? = null
    private var bubble: OverlayBubble? = null
    private val liveFrom = HashMap<Int, String>()

    // push-to-talk: audio recorded before the hub grants the frequency is held, then sent (so the first word isn't lost)
    private val pending = ArrayList<ByteArray>()
    @Volatile private var granted = false
    @Volatile private var keyed = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            stopSelf()
            return START_NOT_STICKY
        }
        prefs = Prefs(this)
        goForeground()
        if (client == null) {
            instance = this
            audio = AudioEngine(this).also { it.volume = prefs.volume }
            client = RadioClient(this)
            RadioState.running = true
        }
        client?.connect(prefs.server, prefs.callsign)
        retune()
        showBubble()
        RadioState.changed()
        return START_STICKY
    }

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Radio", NotificationManager.IMPORTANCE_LOW))
        }
        val n = notification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, RadioService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val tx = prefs.com1
        val station = RadioState.stationOn(tx)
        val text = when {
            RadioState.status != "connected" -> "Radio ${RadioState.status}"
            tx == null -> "Connected - pick a frequency"
            else -> "TX $tx${station?.let { " - ${it.callsign}" } ?: ""}"
        }
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setContentTitle("AutoATC Radio")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_speakerphone)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun refreshNotification() {
        if (!RadioState.running) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
    }

    fun showBubble() {
        if (bubble != null || !Settings.canDrawOverlays(this)) return
        bubble = OverlayBubble(this, prefs) { down -> ptt(down) }.also { it.show() }
    }

    /** COM1 transmits and listens; COM2 only listens. */
    fun retune() {
        val c1 = prefs.com1
        client?.tune(c1, listOfNotNull(c1, prefs.com2))
        refreshNotification()
        RadioState.changed()
    }

    fun setVolume(v: Float) { audio?.volume = v; prefs.volume = v }

    // ---- push-to-talk -----------------------------------------------------------------------------------------------
    fun ptt(down: Boolean) {
        val c = client ?: return
        if (down) {
            if (keyed) return
            if (!c.connected) { RadioState.addLog("!! Radio not connected"); return }
            if (prefs.com1 == null) { RadioState.addLog("!! Pick a COM1 frequency first"); return }
            keyed = true
            granted = false
            synchronized(pending) { pending.clear() }
            val ok = audio?.startMic { chunk, n ->
                if (granted) c.sendAudio(chunk, n) else synchronized(pending) { pending.add(chunk) }
            } ?: false
            if (!ok) { keyed = false; RadioState.addLog("!! Microphone unavailable"); return }
            RadioState.tx = RadioState.Tx.KEYING
            c.ptt(true)
        } else {
            if (!keyed) return
            keyed = false
            audio?.stopMic()
            if (granted) c.ptt(false)
            granted = false
            RadioState.tx = RadioState.Tx.IDLE
        }
        RadioState.changed()
    }

    // ---- hub events (main thread) ----------------------------------------------------------------------------------
    override fun onStatus(state: String) {
        RadioState.status = state
        if (state != "connected" && keyed) ptt(false)
        refreshNotification()
        RadioState.changed()
    }

    override fun onStations(stations: List<Station>) {
        RadioState.stations = stations
        refreshNotification()
        RadioState.changed()
    }

    override fun onPtt(granted: Boolean, freq: String?, reason: String?) {
        val c = client ?: return
        if (!keyed) { if (granted) c.ptt(false); return } // released before the answer came
        if (granted) {
            synchronized(pending) {
                for (chunk in pending) c.sendAudio(chunk, chunk.size)
                pending.clear()
                this.granted = true
            }
            RadioState.tx = RadioState.Tx.TRANSMITTING
        } else {
            keyed = false
            audio?.stopMic()
            RadioState.tx = RadioState.Tx.IDLE
            RadioState.addLog("!! Can't transmit: ${reason ?: "denied"}")
        }
        RadioState.changed()
    }

    override fun onRxStart(stream: Int, freq: String, from: String) { liveFrom[stream] = from }
    override fun onRxAudio(stream: Int, pcm: ByteArray) { audio?.playLive(pcm) }
    override fun onRxEnd(stream: Int) { liveFrom.remove(stream) }

    override fun onText(freq: String, from: String?, text: String) {
        RadioState.addLog("$freq  ${from ?: "?"}: $text")
    }

    override fun onClip(freq: String, from: String, text: String, mp3: ByteArray?) {
        RadioState.lastAtc = "$from: $text"
        RadioState.addLog("$freq  $from: $text")
        if (mp3 != null) audio?.playClip(mp3)
    }

    // ---- shutdown --------------------------------------------------------------------------------------------------
    private fun shutdown() {
        if (keyed) ptt(false)
        bubble?.hide()
        bubble = null
        client?.disconnect()
        client = null
        audio?.release()
        audio = null
        instance = null
        RadioState.running = false
        RadioState.status = "off"
        RadioState.tx = RadioState.Tx.IDLE
        RadioState.changed()
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }
}
