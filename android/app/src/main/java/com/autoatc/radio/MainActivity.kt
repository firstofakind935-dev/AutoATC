package com.autoatc.radio

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView

/**
 * The app screen: callsign, server, COM1/COM2, start/stop, overlay permission, an in-app talk button and the log.
 * Built in code (no layouts) to keep the project small.
 */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var status: TextView
    private lateinit var callsign: EditText
    private lateinit var server: EditText
    private lateinit var com1: Spinner
    private lateinit var com2: Spinner
    private lateinit var startStop: Button
    private lateinit var overlay: Button
    private lateinit var talk: Button
    private lateinit var log: TextView

    private var com1Items: List<String?> = emptyList()
    private var com2Items: List<String?> = emptyList()
    private var shownStations: List<Station>? = null
    private var suppressSpinner = false
    private val refresh: () -> Unit = { update() }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(build())
    }

    override fun onResume() {
        super.onResume()
        RadioState.listen(refresh)
        RadioService.instance?.showBubble() // overlay permission may have just been granted
        update()
    }

    override fun onPause() {
        RadioState.unlisten(refresh)
        saveFields()
        super.onPause()
    }

    // ---- layout ------------------------------------------------------------------------------------------------------
    @SuppressLint("ClickableViewAccessibility", "SetTextI18n")
    private fun build(): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        fun label(t: String) = TextView(this).apply { text = t; textSize = 13f; setPadding(0, dp(12), 0, dp(2)) }

        col.addView(TextView(this).apply { text = "AutoATC Radio"; textSize = 22f; setTextColor(Color.rgb(80, 220, 140)) })
        status = TextView(this).apply { textSize = 14f; setPadding(0, dp(4), 0, 0) }
        col.addView(status)

        col.addView(label("Callsign"))
        callsign = EditText(this).apply {
            setText(prefs.callsign)
            hint = "e.g. DAL123"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            isSingleLine = true
        }
        col.addView(callsign)

        col.addView(label("COM1 (talk + listen)"))
        com1 = Spinner(this)
        col.addView(com1)
        col.addView(label("COM2 (listen only)"))
        com2 = Spinner(this)
        col.addView(com2)
        val pick = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (suppressSpinner) return
                prefs.com1 = com1Items.getOrNull(com1.selectedItemPosition)
                prefs.com2 = com2Items.getOrNull(com2.selectedItemPosition)
                RadioService.instance?.retune()
                update()
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        com1.onItemSelectedListener = pick
        com2.onItemSelectedListener = pick

        startStop = Button(this).apply { setOnClickListener { toggleRadio() } }
        col.addView(startStop, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

        overlay = Button(this).apply {
            text = "Allow floating talk button over the game"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
        }
        col.addView(overlay)

        talk = Button(this).apply {
            text = "Hold to talk"
            textSize = 18f
            setOnTouchListener { _, e ->
                when (e.actionMasked) {
                    MotionEvent.ACTION_DOWN -> RadioService.instance?.ptt(true)
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> RadioService.instance?.ptt(false)
                }
                false
            }
        }
        col.addView(talk, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(80)).apply { topMargin = dp(8) })

        col.addView(label("Volume"))
        col.addView(SeekBar(this).apply {
            max = 100
            progress = (prefs.volume * 100).toInt()
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar?, p: Int, fromUser: Boolean) {
                    if (!fromUser) return
                    prefs.volume = p / 100f
                    RadioService.instance?.setVolume(p / 100f)
                }
                override fun onStartTrackingTouch(s: SeekBar?) {}
                override fun onStopTrackingTouch(s: SeekBar?) {}
            })
        })

        col.addView(label("Server"))
        server = EditText(this).apply {
            setText(prefs.server)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
            textSize = 13f
        }
        col.addView(server)

        col.addView(label("Radio log"))
        log = TextView(this).apply { textSize = 12f; typeface = android.graphics.Typeface.MONOSPACE; gravity = Gravity.START }
        col.addView(log)

        return ScrollView(this).apply { addView(col); setBackgroundColor(Color.rgb(12, 18, 16)) }
    }

    // ---- actions -----------------------------------------------------------------------------------------------------
    private fun saveFields() {
        prefs.callsign = callsign.text.toString().trim().uppercase()
        prefs.server = server.text.toString().trim().ifBlank { Prefs.DEFAULT_SERVER }
    }

    private fun toggleRadio() {
        if (RadioState.running) { RadioService.stop(this); return }
        saveFields()
        if (prefs.callsign.isBlank()) { RadioState.addLog("!! Enter your callsign first"); return }
        val need = mutableListOf<String>()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (need.isNotEmpty()) { requestPermissions(need.toTypedArray(), 1); return }
        RadioService.start(this)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) RadioService.start(this)
        else RadioState.addLog("!! The radio needs the microphone permission")
    }

    // ---- display -----------------------------------------------------------------------------------------------------
    @SuppressLint("SetTextI18n")
    private fun update() {
        val st = RadioState.status
        status.text = when {
            !RadioState.running -> "Radio off"
            st != "connected" -> "Radio $st…"
            RadioState.tx == RadioState.Tx.TRANSMITTING -> "TRANSMITTING on ${prefs.com1}"
            else -> "Connected as ${prefs.callsign}"
        }
        status.setTextColor(when {
            RadioState.tx == RadioState.Tx.TRANSMITTING -> Color.rgb(240, 80, 80)
            st == "connected" -> Color.rgb(80, 220, 140)
            else -> Color.rgb(200, 200, 200)
        })
        startStop.text = if (RadioState.running) "Stop radio" else "Start radio"
        callsign.isEnabled = !RadioState.running
        server.isEnabled = !RadioState.running
        overlay.visibility = if (Settings.canDrawOverlays(this)) View.GONE else View.VISIBLE
        talk.isEnabled = RadioState.running && st == "connected"
        talk.text = when (RadioState.tx) {
            RadioState.Tx.TRANSMITTING -> "Transmitting…"
            RadioState.Tx.KEYING -> "Keying…"
            else -> "Hold to talk"
        }
        log.text = RadioState.log.reversed().joinToString("\n")
        if (shownStations !== RadioState.stations) fillSpinners()
    }

    private fun fillSpinners() {
        val stations = RadioState.stations
        shownStations = stations
        // keep saved frequencies listed even before the hub sends its list
        val freqs = (stations.map { it.freq } + listOfNotNull(prefs.com1, prefs.com2)).distinct()
        fun name(f: String): String {
            val s = stations.firstOrNull { it.freq == f } ?: return f
            return "$f  ${s.callsign}${if (s.human) " (live)" else ""}"
        }
        com1Items = listOf<String?>(null) + freqs
        com2Items = listOf<String?>(null) + freqs
        suppressSpinner = true
        com1.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf("— pick a frequency —") + freqs.map(::name))
        com2.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf("Off") + freqs.map(::name))
        com1.setSelection(com1Items.indexOf(prefs.com1).coerceAtLeast(0), false)
        com2.setSelection(com2Items.indexOf(prefs.com2).coerceAtLeast(0), false)
        com1.post { suppressSpinner = false }
    }
}
