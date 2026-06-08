package debugger

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.project.Project

class CommandExecutor(
    private val project: Project,
    private val bridge: BridgeClient,
    private val tracker: IdeSessionTracker,
    private val variableReader: VariableReader
) {
    fun handle(message: BridgeMessage) {
        when (message.type) {
            MessageTypes.AgentContinue -> execute(message, "continue") { it.resume() }
            MessageTypes.AgentStepOver -> execute(message, "step_over") { it.stepOver(false) }
            MessageTypes.AgentStepInto -> execute(message, "step_into") { it.stepInto() }
            MessageTypes.AgentStepOut -> execute(message, "step_out") { it.stepOut() }
            MessageTypes.AgentStopDebug -> execute(message, "stop_debug") { it.stop() }
            MessageTypes.AgentEvaluate -> evaluate(message)
        }
    }

    private fun execute(message: BridgeMessage, command: String, action: (com.intellij.xdebugger.XDebugSession) -> Unit) {
        val session = tracker.find(message.ideSessionId)
        if (session == null) {
            sendError(message, command, "IDE_SESSION_NOT_FOUND", "IDE debug session was not found.")
            return
        }
        try {
            action(session)
            sendResult(message, command, mapOf("ok" to true))
        } catch (error: Throwable) {
            sendError(message, command, "IDE_COMMAND_FAILED", error.message ?: error.javaClass.name)
        }
    }

    private fun evaluate(message: BridgeMessage) {
        val expression = message.expression
            ?: message.payload["expression"] as? String
            ?: message.options["expression"] as? String
            ?: message.result["expression"] as? String
            ?: message.command?.takeIf { it != "evaluate" }
        if (expression.isNullOrBlank()) {
            sendError(message, "evaluate", "INVALID_ARGUMENT", "Expression is required.")
            return
        }
        variableReader.evaluate(message.ideSessionId, expression) { result, error ->
            if (error != null) {
                sendError(message, "evaluate", "EVALUATE_FAILED", error)
            } else {
                sendResult(message, "evaluate", result ?: emptyMap())
            }
        }
    }

    private fun sendResult(message: BridgeMessage, command: String, result: Map<String, Any?>) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeCommandResult,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                command = command,
                result = result
            )
        )
    }

    private fun sendError(message: BridgeMessage, command: String, code: String, text: String) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeCommandResult,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                command = command,
                error = mapOf(
                    "code" to code,
                    "message" to text
                )
            )
        )
    }
}
