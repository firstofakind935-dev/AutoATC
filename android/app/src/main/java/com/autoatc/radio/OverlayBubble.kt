package com.autoatc.radio

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The floating push-to-talk button drawn over the game: hold the round button to transmit on COM1, drag the grip
 * to move it. Shows the frequency and the last thing a controller said. Never takes focus, so the game keeps the
 * keyboard and touches everywhere else.
 */
class OverlayBubble(private val context: Context, private val prefs: Prefs, private val onPtt: (Boolean) -> Unit) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = prefs.bubbleX
        y = prefs.bubbleY
    }

    private val root = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(4), dp(4), dp(8), dp(4))
        background = GradientDrawable().apply { cornerRadius = dp(28).toFloat(); setColor(Color.argb(170, 10, 16, 14)) }
    }
    private val grip = TextView(context).apply {
        text = "⋮⋮"
        setTextColor(Color.argb(200, 180, 200, 190))
        textSize = 18f
        setPadding(dp(6), dp(8), dp(6), dp(8))
    }
    private val buttonBg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
    private val button = TextView(context).apply {
        text = "PTT"
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        textSize = 14f
        background = buttonBg
        layoutParams = LinearLayout.LayoutParams(dp(56), dp(56))
    }
    private val info = TextView(context).apply {
        setTextColor(Color.rgb(200, 230, 210))
        textSize = 11f
        maxLines = 2
        ellipsize = TextUtils.TruncateAt.END
        maxWidth = dp(180)
        setPadding(dp(8), 0, 0, 0)
    }

    private val refresh: () -> Unit = { update() }
    private var shown = false

    init {
        root.addView(grip)
        root.addView(button)
        root.addView(info)
        setupTouch()
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
        grip.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { startX = params.x; startY = params.y; downX = e.rawX; downY = e.rawY }
                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (e.rawX - downX).toInt()
                    params.y = startY + (e.rawY - downY).toInt()
                    if (shown) wm.updateViewLayout(root, params)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { prefs.bubbleX = params.x; prefs.bubbleY = params.y }
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
        val freq = prefs.com1
        val head = when {
            RadioState.status != "connected" -> "Radio ${RadioState.status}"
            freq == null -> "No COM1 set"
            else -> "$freq ${RadioState.stationOn(freq)?.callsign ?: ""}".trim()
        }
        info.text = RadioState.lastAtc?.let { "$head\n$it" } ?: head
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
        onPtt(false)
        try { wm.removeView(root) } catch (_: Exception) {}
        shown = false
    }
}
