package debugger

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.actions.ConfigurationContext
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager

private data class SourceDebugTarget(
    val settings: RunnerAndConfigurationSettings,
    val sourceElement: String
)

class CommandExecutor(
    private val project: Project,
    private val bridge: BridgeClient,
    private val tracker: IdeSessionTracker,
    private val variableReader: VariableReader
) {
    fun handle(message: BridgeMessage) {
        when (message.type) {
            MessageTypes.AgentStartDebug -> ApplicationManager.getApplication().invokeLater { startDebug(message) }
            MessageTypes.AgentContinue -> execute(message, "continue") { it.resume() }
            MessageTypes.AgentPause -> execute(message, "pause") { it.pause() }
            MessageTypes.AgentStepOver -> execute(message, "step_over") { it.stepOver(false) }
            MessageTypes.AgentStepInto -> execute(message, "step_into") { it.stepInto() }
            MessageTypes.AgentStepOut -> execute(message, "step_out") { it.stepOut() }
            MessageTypes.AgentStopDebug -> execute(message, "stop_debug") { it.stop() }
            MessageTypes.AgentEvaluate -> evaluate(message)
        }
    }

    private fun startDebug(message: BridgeMessage) {
        val runConfigName = message.runConfigName
        if (!runConfigName.isNullOrBlank()) {
            val settings = RunManager.getInstance(project).allSettings
                .firstOrNull { it.name == runConfigName }
            if (settings == null) {
                sendError(message, "start_debug", "RUN_CONFIG_NOT_FOUND", "Run configuration was not found: $runConfigName")
                return
            }
            try {
                ProgramRunnerUtil.executeConfiguration(settings, DefaultDebugExecutor.getDebugExecutorInstance())
                sendResult(message, "start_debug", mapOf("ok" to true, "runConfigName" to runConfigName))
            } catch (error: Throwable) {
                sendError(message, "start_debug", "IDE_COMMAND_FAILED", error.message ?: error.javaClass.name)
            }
            return
        }

        val sourcePath = message.filePath ?: message.file
        if (!sourcePath.isNullOrBlank() && message.line != null) {
            startDebugFromSourceLine(message, sourcePath, message.line)
            return
        }

        sendError(message, "start_debug", "INVALID_ARGUMENT", "Pass runConfigName or filePath + line.")
    }

    private fun startDebugFromSourceLine(message: BridgeMessage, sourcePath: String, line: Int) {
        try {
            val target = findConfigurationForSourceLine(sourcePath, line)
            if (target == null) {
                sendError(
                    message,
                    "start_debug",
                    "RUN_CONFIG_NOT_FOUND",
                    "No runnable debug configuration was found at $sourcePath:$line."
                )
                return
            }
            val runManager = RunManager.getInstance(project)
            if (!runManager.hasSettings(target.settings)) {
                runManager.setTemporaryConfiguration(target.settings)
            }
            ProgramRunnerUtil.executeConfiguration(target.settings, DefaultDebugExecutor.getDebugExecutorInstance())
            sendResult(
                message,
                "start_debug",
                mapOf(
                    "ok" to true,
                    "filePath" to sourcePath,
                    "line" to line,
                    "configurationName" to target.settings.name,
                    "sourceElement" to target.sourceElement
                )
            )
        } catch (error: Throwable) {
            sendError(message, "start_debug", "IDE_COMMAND_FAILED", error.message ?: error.javaClass.name)
        }
    }

    private fun findConfigurationForSourceLine(sourcePath: String, line: Int): SourceDebugTarget? {
        return ApplicationManager.getApplication().runReadAction<SourceDebugTarget?> {
            val virtualFile = LocalFileSystem.getInstance().findFileByPath(sourcePath)
                ?: return@runReadAction null
            val psiFile = PsiManager.getInstance(project).findFile(virtualFile)
                ?: return@runReadAction null
            val document = FileDocumentManager.getInstance().getDocument(virtualFile)
                ?: return@runReadAction null
            val zeroBasedLine = (line - 1).coerceAtLeast(0)
            if (zeroBasedLine >= document.lineCount) return@runReadAction null
            val offset = document.getLineStartOffset(zeroBasedLine)
            var element: PsiElement? = psiFile.findElementAt(offset) ?: psiFile
            while (element != null) {
                val context = ConfigurationContext(element)
                val existing = context.findExisting()
                if (existing != null) {
                    return@runReadAction SourceDebugTarget(existing, element.textRange?.toString() ?: element.javaClass.simpleName)
                }
                val created = context.createConfigurationsFromContext()
                    ?.map { it.configurationSettings }
                    ?.firstOrNull()
                if (created != null) {
                    return@runReadAction SourceDebugTarget(created, element.textRange?.toString() ?: element.javaClass.simpleName)
                }
                element = element.parent
            }
            null
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
