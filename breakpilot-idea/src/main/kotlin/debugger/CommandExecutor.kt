package debugger

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.actions.ConfigurationContext
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import com.intellij.xdebugger.XDebuggerUtil

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
            MessageTypes.AgentRequestStack -> requestStack(message)
            MessageTypes.AgentContinue -> execute(message, "continue") { it.resume() }
            MessageTypes.AgentPause -> execute(message, "pause") { it.pause() }
            MessageTypes.AgentStepOver -> execute(message, "step_over") { it.stepOver(false) }
            MessageTypes.AgentStepInto -> execute(message, "step_into") { it.stepInto() }
            MessageTypes.AgentStepOut -> execute(message, "step_out") { it.stepOut() }
            MessageTypes.AgentRunToLine -> runToLine(message)
            MessageTypes.AgentSetVariable -> setVariable(message)
            MessageTypes.AgentStopDebug -> execute(message, "stop_debug") { it.stop() }
            MessageTypes.AgentEvaluate -> evaluate(message)
            MessageTypes.AgentListRunConfigurations -> listRunConfigurations(message)
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
                executeWithOrigin(settings, message)
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
            executeWithOrigin(target.settings, message)
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

    private fun listRunConfigurations(message: BridgeMessage) {
        val sourcePath = message.filePath ?: message.file
        if (!sourcePath.isNullOrBlank()) {
            listRunPoints(message, sourcePath)
            return
        }
        val configurations = RunManager.getInstance(project).allSettings.map { settings ->
            mapOf(
                "name" to settings.name,
                "description" to settings.type.displayName,
                "supportsDynamicLaunchOverrides" to true
            )
        }
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeRunConfigurationsSnapshot,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch,
                result = mapOf("configurations" to configurations)
            )
        )
    }

    private fun listRunPoints(message: BridgeMessage, sourcePath: String) {
        val file = LocalFileSystem.getInstance().findFileByPath(sourcePath)
        if (file == null) {
            sendRunConfigurationsError(message, "WORKSPACE_VIOLATION", "File was not found in IDEA local filesystem.")
            return
        }
        val document = FileDocumentManager.getInstance().getDocument(file)
        if (document == null) {
            sendRunConfigurationsError(message, "WORKSPACE_VIOLATION", "File cannot be opened as a document.")
            return
        }
        val runPoints = mutableListOf<Map<String, Any?>>()
        val seenElements = mutableSetOf<String>()
        for (lineIndex in 0 until document.lineCount) {
            val target = findConfigurationForSourceLine(sourcePath, lineIndex + 1) ?: continue
            if (!seenElements.add(target.sourceElement)) continue
            runPoints += mapOf(
                "line" to lineIndex + 1,
                "description" to "Run '${target.settings.name}'\nDebug '${target.settings.name}'",
                "elementText" to target.settings.configuration.name
            )
        }
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeRunConfigurationsSnapshot,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch,
                result = mapOf(
                    "filePath" to sourcePath,
                    "runPoints" to runPoints
                )
            )
        )
    }

    private fun sendRunConfigurationsError(message: BridgeMessage, code: String, text: String) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeRunConfigurationsSnapshot,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch,
                error = mapOf(
                    "code" to code,
                    "message" to text
                )
            )
        )
    }

    private fun execute(message: BridgeMessage, command: String, action: (com.intellij.xdebugger.XDebugSession) -> Unit) {
        val session = tracker.find(message.ideSessionId)
        if (session == null) {
            sendError(message, command, "IDE_SESSION_NOT_FOUND", "IDE debug session was not found.")
            return
        }
        try {
            tracker.armOrigin(message.ideSessionId, message.originRequestId ?: message.requestId)
            action(session)
            sendResult(message, command, mapOf("ok" to true))
        } catch (error: Throwable) {
            sendError(message, command, "IDE_COMMAND_FAILED", error.message ?: error.javaClass.name)
        }
    }

    private fun runToLine(message: BridgeMessage) {
        val sourcePath = message.filePath ?: message.file
        val line = message.line
        if (sourcePath.isNullOrBlank() || line == null || line < 1) {
            sendError(message, "run_to_line", "INVALID_ARGUMENT", "filePath and line are required.")
            return
        }
        execute(message, "run_to_line") { session ->
            val file = LocalFileSystem.getInstance().findFileByPath(sourcePath)
                ?: throw IllegalArgumentException("File was not found in IDEA local filesystem: $sourcePath")
            val position = XDebuggerUtil.getInstance().createPosition(file, line - 1)
                ?: throw IllegalArgumentException("No executable source position was found at $sourcePath:$line")
            session.runToPosition(position, false)
        }
    }

    private fun setVariable(message: BridgeMessage) {
        val ref = message.ref as? String
        if (ref != null) {
            variableReader.setNativeValue(message.ideSessionId, ref, message.newValue, message.expectedPauseEpoch) { result, error ->
                if (error != null) sendError(message, "set_variable", error, error)
                else sendResult(message, "set_variable", result ?: emptyMap())
            }
            return
        }
        if (message.path.isEmpty() || message.newValue.isNullOrBlank()) {
            sendError(message, "set_variable", "INVALID_ARGUMENT", "path and newValue are required.")
            return
        }
        val target = message.path.joinToString(".")
        val assignment = "$target = ${message.newValue}"
        variableReader.evaluate(message.ideSessionId, assignment) { result, error ->
            if (error != null) {
                sendError(message, "set_variable", "SET_VARIABLE_FAILED", error)
            } else {
                sendResult(
                    message,
                    "set_variable",
                    mapOf(
                        "path" to message.path,
                        "newValue" to message.newValue,
                        "applied" to true,
                        "result" to result
                    )
                )
            }
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
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch,
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
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch,
                command = command,
                error = mapOf(
                    "code" to code,
                    "message" to text
                )
            )
        )
    }

    private fun executeWithOrigin(settings: RunnerAndConfigurationSettings, message: BridgeMessage) {
        val environment = ExecutionEnvironmentBuilder
            .create(DefaultDebugExecutor.getDebugExecutorInstance(), settings)
            .build()
        environment.putUserData(BreakPilotExecutionOrigin.key, message.originRequestId ?: message.requestId)
        ProgramRunnerUtil.executeConfiguration(environment, false, true)
    }

    private fun requestStack(message: BridgeMessage) {
        val session = tracker.find(message.ideSessionId)
        val epoch = tracker.pauseEpoch(message.ideSessionId)
        if (session == null || epoch == null) {
            sendError(message, "request_stack", "IDE_SESSION_NOT_FOUND", "IDE debug session was not found.")
            return
        }
        if (message.expectedPauseEpoch != epoch) {
            sendError(message, "request_stack", "STALE_RUNTIME_HANDLE", "Stack request belongs to another paused state.")
            return
        }
        StackReader().read(session, message.threadId, message.offset ?: 0, message.limit ?: 20, epoch) { page ->
            bridge.send(
                BridgeMessage(
                    type = MessageTypes.IdeStackSnapshot,
                    requestId = message.requestId,
                    sessionId = message.sessionId,
                    ideSessionId = message.ideSessionId,
                    originRequestId = message.originRequestId,
                    pauseEpoch = epoch,
                    result = page
                )
            )
        }
    }
}
