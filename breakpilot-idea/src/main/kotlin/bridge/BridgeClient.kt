package bridge

import com.google.gson.Gson
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class BridgeClient(private val project: Project) : Disposable {
    private val defaultBridgeUrl = "ws://127.0.0.1:57987/bridge"
    private val gson = Gson()
    private val listeners = mutableListOf<(BridgeMessage) -> Unit>()
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val disposed = AtomicBoolean(false)
    private var socket: WebSocket? = null
    private var explicitBridgeUrl: String? = null
    private var currentBridgeUrl: String? = null
    private var currentInstanceId: String? = null
    private var heartbeat: ScheduledFuture<*>? = null
    private val pending = mutableListOf<BridgeMessage>()

    fun connect(url: String? = null) {
        if (url != null) explicitBridgeUrl = url
        if (disposed.get()) return
        val target = resolveBridgeTarget() ?: run {
            closeSocket()
            scheduleReconnect()
            return
        }
        if (socket != null && currentBridgeUrl == target.url && currentInstanceId == target.instanceId) return
        socket?.abort()
        currentBridgeUrl = target.url
        currentInstanceId = target.instanceId
        val client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build()
        client.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .buildAsync(URI.create(target.url), Listener())
            .exceptionally {
                scheduleReconnect()
                null
            }
    }

    fun onMessage(listener: (BridgeMessage) -> Unit) {
        listeners += listener
    }

    fun send(message: BridgeMessage) {
        enqueueOrSend(message)
    }

    private fun enqueueOrSend(message: BridgeMessage) {
        val current = socket
        if (current == null) {
            pending += message
            return
        }
        val outbound = message.copy(timestamp = Instant.now().toString())
        current.sendText(gson.toJson(outbound), true)
    }

    private fun flushPending() {
        val queued = pending.toList()
        pending.clear()
        queued.forEach { send(it) }
    }

    private fun sendRegister() {
        enqueueOrSend(
            BridgeMessage(
                type = MessageTypes.IdeRegister,
                ide = "idea",
                workspaceRoot = project.basePath,
                capabilities = mapOf(
                    "visualBreakpoints" to true,
                    "debugCommands" to true,
                    "confirmationDialog" to true,
                    "structuredConfirmation" to true,
                    "consentSettings" to true,
                    "toolWindow" to true,
                    "variableSnapshot" to true,
                    "provider" to "xdebugger"
                )
            )
        )
    }

    private fun sendHeartbeat() {
        if (socket != null) enqueueOrSend(BridgeMessage(type = MessageTypes.IdeHeartbeat))
    }

    private fun scheduleHeartbeat() {
        heartbeat?.cancel(false)
        heartbeat = scheduler.scheduleAtFixedRate({
            if (!disposed.get()) sendHeartbeat()
        }, 5, 5, TimeUnit.SECONDS)
    }

    private fun scheduleReconnect() {
        if (disposed.get()) return
        scheduler.schedule({
            if (!disposed.get()) connect()
        }, 2, TimeUnit.SECONDS)
    }

    private fun resolveBridgeTarget(): BridgeTarget? {
        explicitBridgeUrl?.trim()?.takeIf { it.isNotEmpty() }?.let { return BridgeTarget(it, null) }
        return BridgeTarget(defaultBridgeUrl, null)
    }

    override fun dispose() {
        disposed.set(true)
        heartbeat?.cancel(false)
        socket?.sendClose(WebSocket.NORMAL_CLOSURE, "disposed")
        scheduler.shutdownNow()
    }

    private fun closeSocket() {
        heartbeat?.cancel(false)
        heartbeat = null
        socket?.abort()
        socket = null
    }

    private fun emitLocal(message: BridgeMessage) {
        ApplicationManager.getApplication().invokeLater {
            listeners.forEach { it(message) }
        }
    }

    private inner class Listener : WebSocket.Listener {
        private val incoming = StringBuilder()

        override fun onOpen(webSocket: WebSocket) {
            socket = webSocket
            webSocket.request(1)
            sendRegister()
            flushPending()
            scheduleHeartbeat()
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
            incoming.append(data)
            if (last) {
                val text = incoming.toString()
                incoming.setLength(0)
                val message = gson.fromJson(text, BridgeMessage::class.java)
                if (message.type == MessageTypes.BridgeWelcome && message.workspaceRoot != null && project.basePath != null) {
                    if (File(message.workspaceRoot).absolutePath != File(project.basePath!!).absolutePath) {
                        webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "workspace mismatch")
                        return CompletableFuture.completedFuture(null)
                    }
                }
                if (message.type == MessageTypes.BridgeRejected) {
                    webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "bridge rejected")
                    return CompletableFuture.completedFuture(null)
                }
                ApplicationManager.getApplication().invokeLater {
                    listeners.forEach { it(message) }
                }
            }
            webSocket.request(1)
            return CompletableFuture.completedFuture(null)
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*> {
            socket = null
            heartbeat?.cancel(false)
            scheduleReconnect()
            return CompletableFuture.completedFuture(null)
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            socket = null
            heartbeat?.cancel(false)
            scheduleReconnect()
        }
    }

    private data class BridgeTarget(val url: String, val instanceId: String?)
}
