package com.autoatc.radio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.MediaRecorder
import java.io.File
import java.util.concurrent.LinkedBlockingQueue

/**
 * The radio's sound: the microphone while push-to-talk is held (16 kHz mono 16-bit PCM, 20 ms chunks), other
 * pilots live (played as it arrives), and the controllers' replies (MP3 clips, one after another). Volume follows
 * the phone's media volume, so it plays alongside the game.
 */
class AudioEngine(private val context: Context) {
    // The phone's own voice, for replies that arrive without audio (server voice down) or won't play.
    private var tts: android.speech.tts.TextToSpeech? = null
    private var ttsReady = false
    init {
        tts = android.speech.tts.TextToSpeech(context.applicationContext) { status ->
            ttsReady = status == android.speech.tts.TextToSpeech.SUCCESS
            if (ttsReady) tts?.language = java.util.Locale.US
        }
    }
    private var spoken = 0

    /** Reads text out with the phone's voice, after anything already queued. */
    fun speak(text: String) {
        val t = tts ?: return
        if (!ttsReady || text.isBlank()) return
        val params = android.os.Bundle().apply { putFloat(android.speech.tts.TextToSpeech.Engine.KEY_PARAM_VOLUME, volume) }
        t.speak(text, android.speech.tts.TextToSpeech.QUEUE_ADD, params, "atc-${spoken++}")
    }

    companion object {
        const val RATE = 16000
        private const val CHUNK_BYTES = RATE * 2 / 50 // 20 ms
    }

    // ---- microphone -------------------------------------------------------------------------------------------
    @Volatile private var recording = false
    private var recordThread: Thread? = null

    /** Starts the microphone; every chunk goes to `onChunk` (on a background thread) until stopMic(). */
    @SuppressLint("MissingPermission") // RECORD_AUDIO is checked by MainActivity before the radio starts
    fun startMic(onChunk: (ByteArray, Int) -> Unit): Boolean {
        if (recording) return true
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(min, CHUNK_BYTES * 4))
        } catch (e: Exception) { return false }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return false }
        recording = true
        rec.startRecording()
        recordThread = Thread {
            val buf = ByteArray(CHUNK_BYTES)
            try {
                while (recording) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) onChunk(buf.copyOf(n), n)
                }
            } finally {
                try { rec.stop() } catch (_: Exception) {}
                rec.release()
            }
        }.apply { name = "radio-mic"; start() }
        return true
    }

    fun stopMic() {
        recording = false
        recordThread = null
    }

    // ---- live audio from other pilots ---------------------------------------------------------------------------
    private val liveQueue = LinkedBlockingQueue<ByteArray>()
    @Volatile private var running = true
    private val track: AudioTrack = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), RATE / 2))
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
    @Volatile var volume = 1f
        set(v) { field = v.coerceIn(0f, 1f); track.setVolume(field) }

    private val playThread = Thread {
        track.play()
        while (running) {
            val pcm = try { liveQueue.take() } catch (e: InterruptedException) { break }
            if (pcm.isNotEmpty()) track.write(pcm, 0, pcm.size)
        }
    }.apply { name = "radio-play"; start() }

    /** A chunk of a live transmission (any thread). */
    fun playLive(pcm: ByteArray) { liveQueue.offer(pcm) }

    // ---- controllers' replies -------------------------------------------------------------------------------------
    private val clips = ArrayDeque<Pair<File, String>>()
    private var player: MediaPlayer? = null
    private var clipCount = 0

    /** Queues an MP3 reply (main thread); if it won't play, `text` is read out instead. */
    fun playClip(mp3: ByteArray, text: String) {
        val f = File(context.cacheDir, "clip-${clipCount++ % 20}.mp3")
        f.writeBytes(mp3)
        clips.addLast(f to text)
        if (player == null) nextClip()
    }

    private fun nextClip() {
        val (f, text) = clips.removeFirstOrNull() ?: run { player = null; return }
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            mp.setDataSource(f.absolutePath)
            mp.setVolume(volume, volume)
            mp.setOnCompletionListener { it.release(); nextClip() }
            mp.setOnErrorListener { p, _, _ -> p.release(); speak(text); nextClip(); true }
            mp.prepare()
            mp.start()
        } catch (e: Exception) {
            mp.release()
            speak(text)
            nextClip()
        }
    }

    fun release() {
        stopMic()
        running = false
        playThread.interrupt()
        try { track.stop() } catch (_: Exception) {}
        track.release()
        player?.release()
        player = null
        clips.clear()
        tts?.shutdown()
        tts = null
    }
}
