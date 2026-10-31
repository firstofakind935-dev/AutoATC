package com.autoatc.radio

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The little floating push-to-talk button over the game, top right by default: hold it to transmit on COM1 (green =
 * ready, orange = waiting for the frequency, red = on air, grey = not connected). Drag the thin handle on its left
 * to move it. When a controller talks, their words show beside it for a few seconds. Never takes focus, so the game
 * keeps every other touch.
 */
class OverlayBubble(private val context: Context, private val prefs: Prefs, private val onPtt: (Boolean) -> Unit, private val onTuned: () -> Unit = {}) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()
    private val main = Handler(Looper.getMainLooper())

    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.END // x counts from the right edge
        x = prefs.bubbleRight.takeIf { it >= 0 } ?: dp(12)
        y = prefs.bubbleTop.takeIf { it >= 0 } ?: dp(56)
    }

    private val root = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }
    private val info = TextView(context).apply {
        setTextColor(Color.WHITE)
        textSize = 11f
        maxLines = 2
        ellipsize = TextUtils.TruncateAt.END
        maxWidth = dp(200)
        setPadding(dp(8), dp(4), dp(8), dp(4))
        background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(Color.argb(190, 10, 16, 14)) }
        visibility = View.GONE
    }
    private val grip = View(context).apply {
        background = GradientDrawable().apply { cornerRadius = dp(3).toFloat(); setColor(Color.argb(150, 200, 210, 205)) }
        layoutParams = LinearLayout.LayoutParams(dp(6), dp(26)).apply { marginStart = dp(6); marginEnd = dp(4) }
    }
    // a wider invisible touch area around the thin handle
    private val gripArea = LinearLayout(context).apply {
        gravity = Gravity.CENTER
        setPadding(dp(4), dp(8), dp(2), dp(8))
        addView(grip)
    }
    private val buttonBg = GradientDrawable().apply { shape = GradientDrawable.OVAL; setStroke(dp(2), Color.argb(200, 255, 255, 255)) }
    private val button = TextView(context).apply {
        text = "PTT"
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        textSize = 11f
        background = buttonBg
        alpha = 0.92f
        layoutParams = LinearLayout.LayoutParams(dp(46), dp(46))
    }

    // the frequency button under the talk button: opens the station list over the game
    private val freqPanel = FrequencyPanel(context, prefs) { onTuned(); update() }
    private val freqBtn = TextView(context).apply {
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        textSize = 10f
        setPadding(dp(6), dp(3), dp(6), dp(3))
        background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(Color.argb(200, 20, 30, 25)) }
        setOnClickListener { freqPanel.toggle(params.x, params.y) }
    }
    private val buttonCol = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
    }

    private val refresh: () -> Unit = { update() }
    private val hideInfo = Runnable { info.visibility = View.GONE }
    private var shown = false
    private var lastAtcShown: String? = null

    init {
        root.addView(info)
        root.addView(gripArea)
        buttonCol.addView(button)
        buttonCol.addView(freqBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
        root.addView(buttonCol)
        setupTouch()
        lastAtcShown = RadioState.lastAtc
        update()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupTouch() {
        button.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { onPtt(true); true }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { onPtt(false); true }
                else -> true
            }
        }
        var startX = 0; var startY = 0; var downX = 0f; var downY = 0f
        gripArea.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { startX = params.x; startY = params.y; downX = e.rawX; downY = e.rawY }
                MotionEvent.ACTION_MOVE -> {
                    params.x = (startX - (e.rawX - downX).toInt()).coerceAtLeast(0) // from the right edge: moving right shrinks it
                    params.y = (startY + (e.rawY - downY).toInt()).coerceAtLeast(0)
                    if (shown) wm.updateViewLayout(root, params)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { prefs.bubbleRight = params.x; prefs.bubbleTop = params.y }
            }
            true
        }
    }

    private fun update() {
        val color = when {
            RadioState.status != "connected" -> Color.rgb(90, 90, 90)
            RadioState.tx == RadioState.Tx.TRANSMITTING -> Color.rgb(220, 40, 40)
            RadioState.tx == RadioState.Tx.KEYING -> Color.rgb(230, 150, 30)
            else -> Color.rgb(30, 140, 80)
        }
        buttonBg.setColor(color)
        button.text = if (RadioState.tx == RadioState.Tx.TRANSMITTING) "TX" else "PTT"
        freqBtn.text = prefs.com1?.let { "$it ▾" } ?: "FREQ ▾"
        // a new controller message: show it beside the button for a few seconds
        val atc = RadioState.lastAtc
        if (atc != null && atc != lastAtcShown) {
            lastAtcShown = atc
            info.text = atc
            info.visibility = View.VISIBLE
            main.removeCallbacks(hideInfo)
            main.postDelayed(hideInfo, 8000)
        }
    }

    fun show() {
        if (shown) return
        wm.addView(root, params)
        shown = true
        RadioState.listen(refresh)
    }

    fun hide() {
        if (!shown) return
        RadioState.unlisten(refresh)
        freqPanel.close()
        main.removeCallbacks(hideInfo)
        onPtt(false)
        try { wm.removeView(root) } catch (_: Exception) {}
        shown = false
    }
}
