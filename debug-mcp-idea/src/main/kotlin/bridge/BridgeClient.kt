package bridge

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project

class BridgeClient(private val project: Project) : Disposable {
    private val listeners = mutableListOf<(BridgeMessage) -> Unit>()

    fun connect(url: String = "ws://127.0.0.1:27891") {
        // PoC placeholder: use java.net.http.WebSocket in the real plugin.
        send(
            BridgeMessage(
                type = MessageTypes.IdeRegister,
                workspaceRoot = project.basePath,
                payload = mapOf(
                    "ide" to "idea",
                    "capabilities" to mapOf(
                        "visualBreakpoints" to true,
                        "debugCommands" to true,
                        "confirmationDialog" to true,
                        "toolWindow" to true,
                        "variableSnapshot" to "poc-required"
                    )
                )
            )
        )
    }

    fun onMessage(listener: (BridgeMessage) -> Unit) {
        listeners += listener
    }

    fun receive(message: BridgeMessage) {
        listeners.forEach { it(message) }
    }

    fun send(message: BridgeMessage) {
        // Serialize to WebSocket JSON in implementation.
    }

    override fun dispose() {}
}
