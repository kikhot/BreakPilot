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
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.ConcurrentHashMap

class BridgeClient(private val project: Project) : Disposable {
    private val defaultBridgeUrl = "ws://127.0.0.1:57987/bridge"
    private val gson = Gson()
    private val listeners = mutableListOf<(BridgeMessage) -> Unit>()
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val disposed = AtomicBoolean(false)
    @Volatile private var socket: WebSocket? = null
    private val connectionLock = Any()
    private val connectionGeneration = AtomicLong(0)
    private var explicitBridgeUrl: String? = null
    private var currentBridgeUrl: String? = null
    private var currentInstanceId: String? = null
    private var heartbeat: ScheduledFuture<*>? = null
    private val pending = mutableListOf<BridgeMessage>()
    private val requestGenerations = ConcurrentHashMap<String, Long>()

    fun connect(url: String? = null) {
        if (url != null) explicitBridgeUrl = url
        if (disposed.get()) return
        val target = resolveBridgeTarget() ?: run {
            closeSocket()
            scheduleReconnect()
            return
        }
        if (socket != null && currentBridgeUrl == target.url && currentInstanceId == target.instanceId) return
        val oldSocket: WebSocket?
        val generation = synchronized(connectionLock) {
            val next = connectionGeneration.incrementAndGet()
            oldSocket = socket
            socket = null
            next
        }
        requestGenerations.clear()
        synchronized(pending) { pending.clear() }
        oldSocket?.abort()
        currentBridgeUrl = target.url
        currentInstanceId = target.instanceId
        val client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build()
        client.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .buildAsync(URI.create(target.url), Listener(generation))
            .exceptionally {
                if (connectionGeneration.get() == generation) scheduleReconnect()
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
        synchronized(connectionLock) {
            val correlationId = message.requestId ?: message.confirmationId
            val generation = connectionGeneration.get()
            if (correlationId != null && requestGenerations[correlationId] != generation) return
            val current = socket
            if (current == null) {
                synchronized(pending) { pending += message }
                return
            }
            val outbound = message.copy(timestamp = Instant.now().toString())
            current.sendText(gson.toJson(outbound), true)
            if (correlationId != null) requestGenerations.remove(correlationId)
        }
    }

    private fun sendRegister() {
        enqueueOrSend(
            BridgeMessage(
                type = MessageTypes.IdeRegister,
                ide = "idea",
                workspaceRoot = project.basePath,
                debuggerProtocolVersion = 2,
                debuggerFeatures = mapOf(
                    "breakpointUpdate" to true,
                    "eventStream" to true,
                    "stackPagination" to true,
                    "variableHandles" to true,
                    "nativeSetVariable" to true,
                    "causalDebugStart" to true
                ),
                capabilities = mapOf(
                    "visualBreakpoints" to true,
                    "debugCommands" to true,
                    "confirmationDialog" to true,
                    "structuredConfirmation" to true,
                    "consentSettings" to true,
                    "toolWindow" to true,
                    "variableSnapshot" to true,
                    "threads" to true,
                    "stackTrace" to true,
                    "runToLine" to true,
                    "setVariable" to true,
                    "setVariableMode" to "evaluateAssignment",
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
        connectionGeneration.incrementAndGet()
        requestGenerations.clear()
        heartbeat?.cancel(false)
        socket?.sendClose(WebSocket.NORMAL_CLOSURE, "disposed")
        scheduler.shutdownNow()
    }

    private fun closeSocket() {
        connectionGeneration.incrementAndGet()
        requestGenerations.clear()
        heartbeat?.cancel(false)
        heartbeat = null
        socket?.abort()
        socket = null
        synchronized(pending) { pending.clear() }
    }

    private fun emitLocal(message: BridgeMessage) {
        ApplicationManager.getApplication().invokeLater {
            listeners.forEach { it(message) }
        }
    }

    private inner class Listener(private val generation: Long) : WebSocket.Listener {
        private val incoming = StringBuilder()

        override fun onOpen(webSocket: WebSocket) {
            val accepted = synchronized(connectionLock) {
                if (disposed.get() || connectionGeneration.get() != generation) false
                else {
                    socket = webSocket
                    true
                }
            }
            if (!accepted) {
                webSocket.abort()
                return
            }
            webSocket.request(1)
            synchronized(pending) { pending.clear() }
            sendRegister()
            emitLocal(BridgeMessage(type = MessageTypes.BridgeConnected, workspaceRoot = project.basePath))
            scheduleHeartbeat()
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
            if (!isCurrent(webSocket, generation)) {
                webSocket.request(1)
                return CompletableFuture.completedFuture(null)
            }
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
                val correlationId = message.requestId ?: message.confirmationId
                if (correlationId != null) requestGenerations[correlationId] = generation
                ApplicationManager.getApplication().invokeLater {
                    if (!isCurrent(webSocket, generation)) return@invokeLater
                    listeners.forEach { it(message) }
                }
            }
            webSocket.request(1)
            return CompletableFuture.completedFuture(null)
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*> {
            if (clearCurrent(webSocket, generation)) {
                synchronized(pending) { pending.clear() }
                requestGenerations.clear()
                heartbeat?.cancel(false)
                emitLocal(BridgeMessage(type = MessageTypes.BridgeDisconnected, workspaceRoot = project.basePath))
                scheduleReconnect()
            }
            return CompletableFuture.completedFuture(null)
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            if (clearCurrent(webSocket, generation)) {
                synchronized(pending) { pending.clear() }
                requestGenerations.clear()
                heartbeat?.cancel(false)
                emitLocal(BridgeMessage(type = MessageTypes.BridgeDisconnected, workspaceRoot = project.basePath))
                scheduleReconnect()
            }
        }
    }

    private fun isCurrent(webSocket: WebSocket, generation: Long): Boolean = synchronized(connectionLock) {
        socket === webSocket && connectionGeneration.get() == generation && !disposed.get()
    }

    private fun clearCurrent(webSocket: WebSocket, generation: Long): Boolean = synchronized(connectionLock) {
        if (socket !== webSocket || connectionGeneration.get() != generation) false
        else {
            socket = null
            true
        }
    }

    private data class BridgeTarget(val url: String, val instanceId: String?)
}
