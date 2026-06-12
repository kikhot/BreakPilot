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

    fun register(session: XDebugSession) {
        val ideSessionId = sessionId(session)
        if (sessions.containsKey(ideSessionId)) return
        sessions[ideSessionId] = session
        bridge.send(sessionMessage(MessageTypes.IdeSessionStarted, session, "running"))
        session.addSessionListener(
            object : XDebugSessionListener {
                override fun sessionPaused() {
                    bridge.send(sessionMessage(MessageTypes.IdeSessionPaused, session, "paused"))
                }

                override fun sessionResumed() {
                    bridge.send(sessionMessage(MessageTypes.IdeSessionResumed, session, "running"))
                }

                override fun sessionStopped() {
                    sessions.remove(ideSessionId)
                    onSessionTerminated(ideSessionId)
                    bridge.send(sessionMessage(MessageTypes.IdeSessionTerminated, session, "terminated"))
                }

                override fun stackFrameChanged() {
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
