package debugger

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.XDebugProcess
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.XDebugSessionListener
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.XDebuggerManagerListener

class IdeSessionTracker(
    private val project: Project,
    private val bridge: BridgeClient,
    private val onSessionTerminated: (String) -> Unit = {}
) {
    private val sessions = mutableMapOf<String, XDebugSession>()
    private val pauseEpochs = mutableMapOf<String, Long>()
    private val pendingOrigins = mutableMapOf<String, String>()
    private val epochListeners = mutableListOf<(String) -> Unit>()

    fun start() {
        XDebuggerManager.getInstance(project).debugSessions.forEach { register(it) }
        project.messageBus.connect(project).subscribe(
            XDebuggerManager.TOPIC,
            object : XDebuggerManagerListener {
                override fun processStarted(debugProcess: XDebugProcess) {
                    register(debugProcess.session)
                }

                override fun processStopped(debugProcess: XDebugProcess) {
                    val session = debugProcess.session
                    val ideSessionId = sessionId(session)
                    sessions.remove(ideSessionId)
                    advanceEpoch(ideSessionId)
                    onSessionTerminated(ideSessionId)
                    bridge.send(
                        BridgeMessage(
                            type = MessageTypes.IdeSessionTerminated,
                            ideSessionId = ideSessionId,
                            workspaceRoot = project.basePath,
                            name = session.sessionName,
                            state = "terminated"
                        )
                    )
                }
            }
        )
    }

    fun find(ideSessionId: String?): XDebugSession? {
        if (ideSessionId != null) return sessions[ideSessionId]
        return XDebuggerManager.getInstance(project).currentSession
    }

    fun sessionId(session: XDebugSession): String {
        return "idea_${System.identityHashCode(session).toString(36)}"
    }

    fun pauseEpoch(ideSessionId: String?): Long? = ideSessionId?.let { pauseEpochs[it] }

    fun onEpochChanged(listener: (String) -> Unit) {
        epochListeners += listener
    }

    fun armOrigin(ideSessionId: String?, originRequestId: String?) {
        if (ideSessionId != null && originRequestId != null) pendingOrigins[ideSessionId] = originRequestId
    }

    fun register(session: XDebugSession) {
        val ideSessionId = sessionId(session)
        if (sessions.containsKey(ideSessionId)) return
        sessions[ideSessionId] = session
        pauseEpochs[ideSessionId] = 0
        bridge.send(sessionMessage(MessageTypes.IdeSessionStarted, session, "running"))
        session.addSessionListener(
            object : XDebugSessionListener {
                override fun sessionPaused() {
                    advanceEpoch(ideSessionId)
                    bridge.send(sessionMessage(MessageTypes.IdeSessionPaused, session, "paused"))
                    sendDebugEvent(session, "stopped", mapOf("data" to mapOf("reason" to "breakpoint")))
                    pendingOrigins.remove(ideSessionId)
                }

                override fun sessionResumed() {
                    advanceEpoch(ideSessionId)
                    bridge.send(sessionMessage(MessageTypes.IdeSessionResumed, session, "running"))
                    sendDebugEvent(session, "continued")
                }

                override fun sessionStopped() {
                    sessions.remove(ideSessionId)
                    advanceEpoch(ideSessionId)
                    onSessionTerminated(ideSessionId)
                    bridge.send(sessionMessage(MessageTypes.IdeSessionTerminated, session, "terminated"))
                }

                override fun stackFrameChanged() {
                    advanceEpoch(ideSessionId)
                    bridge.send(sessionMessage(MessageTypes.IdeSessionPaused, session, "paused"))
                }
            }
        )
    }

    private fun sessionMessage(type: String, session: XDebugSession, state: String): BridgeMessage {
        val frame = frameMap(session)
        return BridgeMessage(
            type = type,
            ideSessionId = sessionId(session),
            workspaceRoot = project.basePath,
            name = session.sessionName,
            language = "idea",
            state = state,
            active = XDebuggerManager.getInstance(project).currentSession === session,
            threadId = 0,
            topFrame = frame,
            stopped = mapOf(
                "reason" to "breakpoint",
                "threadId" to 0,
                "description" to "IDE debug session paused.",
                "topFrame" to frame
            ),
            debuggerProtocolVersion = 2,
            debuggerFeatures = mapOf(
                "breakpointUpdate" to true,
                "eventStream" to true,
                "stackPagination" to true,
                "variableHandles" to true,
                "nativeSetVariable" to true,
                "causalDebugStart" to true
            ),
            pauseEpoch = pauseEpochs[sessionId(session)] ?: 0,
            originRequestId = pendingOrigins[sessionId(session)]
                ?: session.executionEnvironment?.getUserData(BreakPilotExecutionOrigin.key)
        )
    }

    private fun advanceEpoch(ideSessionId: String) {
        pauseEpochs[ideSessionId] = (pauseEpochs[ideSessionId] ?: 0) + 1
        epochListeners.forEach { it(ideSessionId) }
    }

    private fun sendDebugEvent(session: XDebugSession, kind: String, extra: Map<String, Any?> = emptyMap()) {
        val ideSessionId = sessionId(session)
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeDebugEvent,
                ideSessionId = ideSessionId,
                pauseEpoch = pauseEpochs[ideSessionId] ?: 0,
                event = mapOf("kind" to kind) + extra
            )
        )
    }

    private fun frameMap(session: XDebugSession): Map<String, Any?> {
        val frame = session.currentStackFrame ?: return emptyMap()
        val position = frame.sourcePosition
        return mapOf(
            "id" to System.identityHashCode(frame),
            "name" to frame.javaClass.simpleName,
            "line" to ((position?.line ?: -1) + 1),
            "column" to 1,
            "source" to mapOf(
                "name" to position?.file?.name,
                "path" to position?.file?.path
            )
        )
    }
}
