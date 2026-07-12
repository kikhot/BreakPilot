package debugger

import bridge.AgentBreakpoint
import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XBreakpoint
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import com.intellij.xdebugger.breakpoints.XLineBreakpoint
import com.intellij.xdebugger.breakpoints.XLineBreakpointType

class BreakpointSync(
    private val project: Project,
    private val bridge: BridgeClient
) {
    private val agentBreakpointIdKey = Key.create<String>("breakpilot.agent.breakpoint.id")

    private data class AgentBreakpointEntry(
        val breakpoint: XBreakpoint<*>,
        val sessionId: String?,
        val workspaceRoot: String?
    )

    private val byAgentId = mutableMapOf<String, AgentBreakpointEntry>()

    fun handle(message: BridgeMessage) {
        when (message.type) {
            MessageTypes.AgentSetBreakpoint -> message.breakpoint?.let { addAgentBreakpoint(it, message.requestId, message) }
            MessageTypes.AgentRemoveBreakpoint -> message.breakpointId?.let { removeAgentBreakpoint(it, message) }
            MessageTypes.AgentListBreakpoints -> listBreakpoints(message)
            MessageTypes.AgentClearBreakpoints, MessageTypes.BridgeDisconnected -> clearAgentBreakpoints(message.sessionId, message.workspaceRoot)
        }
    }

    private fun addAgentBreakpoint(breakpoint: AgentBreakpoint, requestId: String?, message: BridgeMessage) {
        val file = LocalFileSystem.getInstance().findFileByPath(breakpoint.file) ?: run {
            bridge.send(
                BridgeMessage(
                    type = MessageTypes.IdeBreakpointAdded,
                    requestId = requestId,
                    breakpointId = breakpoint.id,
                    breakpoint = breakpoint,
                    error = mapOf(
                        "code" to "WORKSPACE_VIOLATION",
                        "message" to "File was not found in IDEA local filesystem."
                    )
                )
            )
            return
        }
        val manager = XDebuggerManager.getInstance(project).breakpointManager
        byAgentId.remove(breakpoint.id)?.let { manager.removeBreakpoint(it.breakpoint) }
        val type = XLineBreakpointType.EXTENSION_POINT_NAME.extensionList
            .filterIsInstance<XLineBreakpointType<*>>()
            .firstOrNull { it.canPutAt(file, breakpoint.line - 1, project) }
            ?: run {
                bridge.send(
                    BridgeMessage(
                        type = MessageTypes.IdeBreakpointAdded,
                        requestId = requestId,
                        breakpointId = breakpoint.id,
                        breakpoint = breakpoint,
                        error = mapOf(
                            "code" to "BREAKPOINT_NOT_VERIFIED",
                            "message" to "No IDEA line breakpoint type can be placed at this location."
                        )
                    )
                )
                return
            }
        @Suppress("UNCHECKED_CAST")
        val typed = type as XLineBreakpointType<XBreakpointProperties<*>>
        val lineBreakpoint = manager.addLineBreakpoint(
            typed,
            file.url,
            breakpoint.line - 1,
            typed.createBreakpointProperties(file, breakpoint.line - 1)
        )
        lineBreakpoint.putUserData(agentBreakpointIdKey, breakpoint.id)
        byAgentId[breakpoint.id] = AgentBreakpointEntry(lineBreakpoint, message.sessionId, message.workspaceRoot)
        notify("BreakPilot set a breakpoint at ${file.name}:${breakpoint.line}.")
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeBreakpointAdded,
                requestId = requestId,
                breakpointId = breakpoint.id,
                breakpoint = breakpoint.copy(verified = true)
            )
        )
    }

    private fun removeAgentBreakpoint(agentId: String, message: BridgeMessage) {
        val manager = XDebuggerManager.getInstance(project).breakpointManager
        val entry = byAgentId[agentId]
        val removed = if (entry != null) {
            manager.removeBreakpoint(entry.breakpoint)
            byAgentId.remove(agentId)
            true
        } else {
            removeStoredAgentBreakpoint(manager, agentId)
        }
        if (removed) notify("BreakPilot removed an agent breakpoint.")
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeBreakpointRemoved,
                requestId = message.requestId,
                breakpointId = agentId,
                removed = removed
            )
        )
    }

    private fun removeStoredAgentBreakpoint(
        manager: com.intellij.xdebugger.breakpoints.XBreakpointManager,
        agentId: String
    ): Boolean {
        val all = manager.allBreakpoints.toList()
        val marked = all.firstOrNull { it.getUserData(agentBreakpointIdKey) == agentId }
        if (marked != null) {
            manager.removeBreakpoint(marked)
            return true
        }
        return false
    }

    fun clearAgentBreakpoints(sessionId: String? = null, workspaceRoot: String? = null) {
        val manager = XDebuggerManager.getInstance(project).breakpointManager
        val removed = byAgentId
            .filter { (_, entry) ->
                (sessionId == null || entry.sessionId == sessionId) &&
                    (workspaceRoot == null || entry.workspaceRoot == null || entry.workspaceRoot == workspaceRoot)
            }
            .keys
            .toList()
        removed.forEach { agentId ->
            byAgentId.remove(agentId)?.let { manager.removeBreakpoint(it.breakpoint) }
        }
        if (removed.isNotEmpty()) notify("BreakPilot cleared agent breakpoints.")
    }

    private fun listBreakpoints(message: BridgeMessage) {
        val breakpoints = XDebuggerManager.getInstance(project)
            .breakpointManager
            .allBreakpoints
            .mapIndexedNotNull { index, breakpoint -> breakpointSnapshot(index, breakpoint) }
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeBreakpointsSnapshot,
                requestId = message.requestId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                result = mapOf("breakpoints" to breakpoints)
            )
        )
    }

    private fun breakpointSnapshot(index: Int, breakpoint: XBreakpoint<*>): Map<String, Any?>? {
        val agentId = breakpoint.getUserData(agentBreakpointIdKey)
        val owner = if (agentId != null) "agent" else "user"
        if (breakpoint is XLineBreakpoint<*>) {
            val filePath = VirtualFileManager.getInstance().findFileByUrl(breakpoint.fileUrl)?.path
                ?: breakpoint.fileUrl.removePrefix("file://")
            val id = agentId ?: "line|${breakpoint.fileUrl}|${breakpoint.line}"
            return mapOf(
                "id" to id,
                "ideBreakpointId" to id,
                "type" to "line",
                "file" to filePath,
                "line" to breakpoint.line + 1,
                "owner" to owner,
                "enabled" to breakpoint.isEnabled,
                "verified" to true,
                "condition" to breakpoint.conditionExpression?.expression
            )
        }
        val id = agentId ?: "${breakpoint.javaClass.simpleName}|$index"
        return mapOf(
            "id" to id,
            "ideBreakpointId" to id,
            "type" to breakpoint.javaClass.simpleName,
            "owner" to owner,
            "enabled" to breakpoint.isEnabled,
            "verified" to true
        )
    }

    private fun notify(content: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("BreakPilot")
            .createNotification(content, NotificationType.INFORMATION)
            .notify(project)
    }
}
