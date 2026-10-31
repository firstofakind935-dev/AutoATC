package com.autoatc.radio

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The station list that opens over the game from the floating button's frequency button: tap a station to tune COM1
 * to it (COM2 can be swapped in). Taps only - no keyboard - so it never takes the game's focus. Closes when a
 * station is picked, on Close, or when the pilot touches the game outside it.
 */
class FrequencyPanel(private val context: Context, private val prefs: Prefs, private val onTuned: () -> Unit) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()
    private var view: View? = null

    val isOpen get() = view != null

    fun toggle(anchorRight: Int, anchorTop: Int) { if (isOpen) close() else open(anchorRight, anchorTop) }

    @SuppressLint("ClickableViewAccessibility")
    fun open(anchorRight: Int, anchorTop: Int) {
        close()
        val list = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val panel = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(Color.argb(235, 14, 20, 17)) }
        }
        val header = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(TextView(context).apply {
            text = "COM1 ${prefs.com1 ?: "—"}" + (prefs.com2?.let { "   COM2 $it" } ?: "")
            setTextColor(Color.WHITE); textSize = 13f
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(chip("Close") { close() })
        panel.addView(header)
        if (prefs.com2 != null) {
            panel.addView(chip("Swap COM1 ⇄ COM2") {
                val a = prefs.com1
                prefs.com1 = prefs.com2
                prefs.com2 = a
                tuned()
            }.apply { (layoutParams as? LinearLayout.LayoutParams)?.topMargin = dp(6) })
        }
        val stations = RadioState.stations.sortedWith(compareBy({ it.callsign.substringBefore(' ') }, { it.freq }))
        if (stations.isEmpty()) {
            list.addView(TextView(context).apply { text = "No stations yet (radio not connected?)"; setTextColor(Color.LTGRAY); textSize = 13f })
        }
        for (s in stations) {
            val current = s.freq == prefs.com1
            list.addView(TextView(context).apply {
                text = "${s.freq}   ${s.callsign}${if (s.human) " (live)" else ""}"
                textSize = 14f
                setTextColor(if (current) Color.rgb(120, 230, 160) else Color.WHITE)
                setPadding(dp(6), dp(9), dp(6), dp(9))
                setOnClickListener { prefs.com1 = s.freq; tuned() }
            })
        }
        panel.addView(ScrollView(context).apply { addView(list) }, LinearLayout.LayoutParams(dp(250), dp(260)).apply { topMargin = dp(6) })

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = anchorRight
            y = anchorTop + dp(54) // just under the floating button
        }
        panel.setOnTouchListener { _, e -> if (e.actionMasked == MotionEvent.ACTION_OUTSIDE) { close(); true } else false }
        wm.addView(panel, params)
        view = panel
    }

    private fun tuned() {
        RadioState.addLog("Tuned COM1 ${prefs.com1}${RadioState.stationOn(prefs.com1)?.let { " (${it.callsign})" } ?: ""}")
        onTuned()
        close()
    }

    private fun chip(label: String, onClick: () -> Unit) = TextView(context).apply {
        text = label
        textSize = 12f
        setTextColor(Color.WHITE)
        setPadding(dp(10), dp(6), dp(10), dp(6))
        background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(Color.argb(255, 40, 60, 50)) }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        setOnClickListener { onClick() }
    }

    fun close() {
        val v = view ?: return
        view = null
        try { wm.removeView(v) } catch (_: Exception) {}
    }
}
