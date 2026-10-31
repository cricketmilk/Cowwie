package com.professionalgoat.desk

import android.app.Notification
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.professionalgoat.data.Settings
import org.json.JSONArray
import org.json.JSONObject

/**
 * Every notification this phone shows, told to the desk; every reply the desk
 * sends, typed into the notification's own Reply box.
 *
 * The listener is bound by the system, not by the dashboard: it keeps running
 * with the app closed and the screen off, which is the only reason this is a
 * service. The desk decides what is worth a card (Ifreglen's `lib/comms.js`
 * triage); this side only describes, filters what must never leave, and
 * carries replies.
 *
 * What it never sends: one-time codes (dropped here AND on the desk), its own
 * notifications, group summaries (they repeat their children), and anything
 * ongoing except a ringing call. A media player or a download is not news.
 * Logcat gets flags and counts, never a message's words.
 */
class DeskNotificationListener : NotificationListenerService() {

    private lateinit var settings: Settings
    private lateinit var client: DeskClient
    private var thread: HandlerThread? = null
    private var bg: Handler? = null
    private val queue = ArrayList<JSONObject>()

    // The Reply action of each notification that has one, by key, so a reply
    // from the desk can be typed into it. Bounded: the oldest falls out.
    private val replies = object : LinkedHashMap<String, Notification.Action>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Notification.Action>?) = size > 200
    }
    private var pollUntil = 0L
    private var backoffUntil = 0L

    override fun onListenerConnected() {
        live = this
        settings = Settings(this)
        client = DeskClient(settings)
        thread = HandlerThread("goat-comms").also { it.start() }
        bg = Handler(thread!!.looper)
        log("listener connected")
        snapshot()
    }

    override fun onListenerDisconnected() {
        live = null
        log("listener disconnected")
        thread?.quitSafely()
        thread = null
        bg = null
    }

    private fun active() = settings.bridgeEnabled && settings.deskLinked

    /** What the phone shows right now, marked so the desk files it without a card for every message you already saw this morning. */
    private fun snapshot() {
        if (!active()) return
        try {
            activeNotifications?.forEach { sbn ->
                describe(sbn)?.let { it.put("snapshot", true); enqueue(it) }
            }
        } catch (_: Exception) {
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!active()) return
        try {
            val it = describe(sbn) ?: return
            if (it.optBoolean("canReply")) pollUntil = System.currentTimeMillis() + 10 * 60 * 1000
            enqueue(it)
        } catch (_: Exception) {
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        replies.remove(sbn.key)
        if (!active()) return
        if (sbn.packageName == packageName) return
        enqueue(JSONObject().put("key", sbn.key).put("removed", true))
    }

    // ------------------------------------------------------------------ describe

    private fun describe(sbn: StatusBarNotification): JSONObject? {
        if (sbn.packageName == packageName) return null
        val n = sbn.notification
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return null
        val category = n.category ?: ""
        val ongoing = (n.flags and Notification.FLAG_ONGOING_EVENT != 0) ||
            (n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0)
        if (ongoing && category != Notification.CATEGORY_CALL) return null

        val ex: Bundle = n.extras
        var title = str(ex.getCharSequence(Notification.EXTRA_TITLE))
        var text = str(ex.getCharSequence(Notification.EXTRA_BIG_TEXT))
        if (text.isEmpty()) text = str(ex.getCharSequence(Notification.EXTRA_TEXT))
        var thread = ""
        var mine = false

        // A conversation says who said the last thing, and in a group, where.
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        if (style != null && style.messages.isNotEmpty()) {
            val last = style.messages.last()
            text = str(last.text)
            val sender = last.person?.name
            // In a MessagingStyle a message with no sender is the user's own:
            // the app adding "You: ..." after a reply. Filed, never announced.
            mine = last.person == null
            if (style.isGroupConversation && style.conversationTitle != null) {
                thread = str(style.conversationTitle)
                if (sender != null) title = str(sender)
            } else if (sender != null) {
                title = str(sender)
            }
        }
        if (title.isEmpty() && text.isEmpty()) return null
        if (Sensitive.test(title, text)) {
            settings.bump(Settings.COUNT_DROPPED)
            return null
        }

        val reply = replyAction(n)
        if (reply != null) replies[sbn.key] = reply else replies.remove(sbn.key)

        return JSONObject().apply {
            put("key", sbn.key)
            put("pkg", sbn.packageName)
            put("app", label(sbn.packageName))
            put("title", title.take(80))
            put("text", text.take(600))
            put("thread", thread.take(120))
            if (category.isNotEmpty()) put("category", category)
            put("canReply", reply != null)
            put("ongoing", ongoing)
            put("when", n.`when`)
            if (mine) put("mine", true)
        }
    }

    /** The action you could type into: its own, or the one it gives a watch. */
    private fun replyAction(n: Notification): Notification.Action? {
        n.actions?.firstOrNull(::typeable)?.let { return it }
        return Notification.WearableExtender(n).actions.firstOrNull(::typeable)
    }

    private fun typeable(a: Notification.Action): Boolean =
        a.remoteInputs?.any { it.allowFreeFormInput } == true

    private fun label(pkg: String): String = try {
        val pm = packageManager
        str(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)))
    } catch (_: Exception) {
        // Android 11+ hides other apps unless asked for by name; the last
        // word of the package is a readable fallback ("messaging").
        pkg.substringAfterLast('.')
    }

    private fun str(s: CharSequence?): String = s?.toString()?.trim().orEmpty()

    // ------------------------------------------------------------------ carry

    private fun enqueue(it: JSONObject) {
        synchronized(queue) {
            // A newer copy of the same notification replaces the older one
            // still waiting: the desk only needs what it says now. But a
            // snapshot copy must never demote an arrival that has not been
            // delivered yet, or a text that came in during re-pairing is filed
            // quietly and never shown.
            val key = it.optString("key")
            for (i in queue.indices.reversed()) {
                val old = queue[i]
                if (key != old.optString("key")) continue
                if (it.optBoolean("snapshot") && !old.optBoolean("snapshot") && !old.optBoolean("removed")) it.remove("snapshot")
                queue.removeAt(i)
            }
            queue.add(it)
            while (queue.size > 200) queue.removeAt(0)
            log(
                "queued ${it.optString("pkg")}" +
                    (if (it.optBoolean("removed")) " removed" else "") +
                    (if (it.optBoolean("snapshot")) " snapshot" else "") +
                    (if (it.optBoolean("canReply")) " canReply" else "") +
                    " (${queue.size} waiting)",
            )
        }
        val h = bg ?: return
        h.removeCallbacks(flush)
        h.postDelayed(flush, 400) // a burst of five texts is one post
    }

    private val flush: Runnable = object : Runnable {
        override fun run() {
            val h = bg ?: return
            val now = System.currentTimeMillis()
            if (now < backoffUntil) { h.postDelayed(this, backoffUntil - now); return }
            val batch: List<JSONObject>
            val startGen = settings.pairingGen
            synchronized(queue) {
                if (queue.isEmpty()) return
                batch = ArrayList(queue.subList(0, minOf(50, queue.size)))
            }
            try {
                val outbox = client.postComms(batch)
                synchronized(queue) { queue.removeAll(batch.toSet()) }
                settings.lastCommsPostAt = System.currentTimeMillis()
                settings.lastCommsError = ""
                settings.bump(Settings.COUNT_SENT, batch.size)
                log("sent ${batch.size} to the desk")
                backoffUntil = 0
                carry(outbox)
                synchronized(queue) { if (queue.isNotEmpty()) h.post(this) }
                schedulePoll()
            } catch (e: Exception) {
                settings.lastCommsError = e.message ?: "could not reach the desk"
                log("could not reach the desk: ${e.message}")
                if (e is DeskException && e.unpaired) { synchronized(queue) { queue.clear() }; return }
                // Re-paired while this attempt was in flight: the failure was
                // the OLD address. Try the new one now instead of backing off.
                if (settings.pairingGen != startGen) { backoffUntil = 0; h.post(this); return }
                // Keep them, and try again in a minute: the desk is asleep or
                // on another network, and the phone should not hammer it.
                backoffUntil = System.currentTimeMillis() + 60_000
                h.postDelayed(this, 60_000)
            }
        }
    }

    // Replies are worth waiting for only around a conversation: for ten
    // minutes after something you could reply to arrives, ask every four
    // seconds; otherwise never. A phone in a drawer polling all night is a
    // battery bill for nothing.
    private val poll: Runnable = object : Runnable {
        override fun run() {
            if (System.currentTimeMillis() > pollUntil) return
            try { carry(client.commsOutbox()) } catch (_: Exception) {}
            bg?.postDelayed(this, 4000)
        }
    }

    private fun schedulePoll() {
        val h = bg ?: return
        if (System.currentTimeMillis() > pollUntil) return
        h.removeCallbacks(poll)
        h.postDelayed(poll, 4000)
    }

    /** Type each reply into its notification's Reply box, and say how it went. */
    private fun carry(outbox: JSONArray?) {
        if (outbox == null) return
        for (i in 0 until outbox.length()) {
            val r = outbox.optJSONObject(i) ?: continue
            var error: String? = null
            val a = replies[r.optString("key")]
            if (a == null) error = "the phone no longer shows that message"
            else try { send(this, a, r.optString("text")) } catch (e: Exception) { error = "the reply did not go: ${e.message}" }
            try {
                client.ackComms(r.optString("id"), error == null, error)
                if (error == null) settings.bump(Settings.COUNT_REPLIES)
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        private const val TAG = "GoatBridge"

        @Volatile
        private var live: DeskNotificationListener? = null

        fun log(msg: String) { Log.i(TAG, msg) }

        /** Whether the user has granted notification access to this app. */
        fun accessGranted(c: Context): Boolean =
            NotificationManagerCompat.getEnabledListenerPackages(c).contains(c.packageName)

        /** Whether the system currently has the listener bound. */
        fun isBound(): Boolean = live != null

        /**
         * Ask Android to bind the listener again if access is granted but it is
         * not running. After a force-stop (or a crash) Android does not rebind a
         * listener when the app is next opened; without this the bridge stays
         * down, silently, until some later system event happens to rebind it.
         */
        fun rebind(c: Context) {
            if (live != null || !accessGranted(c)) return
            log("listener not bound; asking Android to rebind it")
            requestRebind(ComponentName(c, DeskNotificationListener::class.java))
        }

        /** The desk is reachable again, or was just re-paired: send what is queued now. */
        fun kick() {
            val l = live ?: return
            val h = l.bg ?: return
            l.backoffUntil = 0
            h.removeCallbacks(l.flush)
            h.post(l.flush)
        }

        /** From the settings switch: send what is showing now, once. */
        fun resync() {
            val l = live ?: return
            l.bg?.post { l.snapshot() }
        }

        fun send(c: Context, a: Notification.Action, text: String) {
            val inputs = a.remoteInputs ?: throw IllegalStateException("no reply box")
            val fill = Intent().addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
            val results = Bundle()
            inputs.forEach { results.putCharSequence(it.resultKey, text) }
            RemoteInput.addResultsToIntent(inputs, fill, results)
            RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT)
            a.actionIntent.send(c, 0, fill)
        }
    }
}
