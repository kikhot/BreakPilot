package debugger

import bridge.AgentBreakpoint
import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XBreakpoint
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import com.intellij.xdebugger.breakpoints.XLineBreakpointType

class BreakpointSync(
    private val project: Project,
    private val bridge: BridgeClient
) {
    private val byAgentId = mutableMapOf<String, XBreakpoint<*>>()

    fun handle(message: BridgeMessage) {
        when (message.type) {
            MessageTypes.AgentSetBreakpoint -> message.breakpoint?.let { addAgentBreakpoint(it, message.requestId) }
            MessageTypes.AgentRemoveBreakpoint -> message.breakpointId?.let { removeAgentBreakpoint(it, message.requestId) }
        }
    }

    private fun addAgentBreakpoint(breakpoint: AgentBreakpoint, requestId: String?) {
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
        byAgentId.remove(breakpoint.id)?.let { manager.removeBreakpoint(it) }
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
        byAgentId[breakpoint.id] = lineBreakpoint
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

    private fun removeAgentBreakpoint(agentId: String, requestId: String?) {
        val breakpoint = byAgentId.remove(agentId) ?: run {
            bridge.send(
                BridgeMessage(
                    type = MessageTypes.IdeBreakpointRemoved,
                    requestId = requestId,
                    breakpointId = agentId
                )
            )
            return
        }
        XDebuggerManager.getInstance(project).breakpointManager.removeBreakpoint(breakpoint)
        notify("BreakPilot removed an agent breakpoint.")
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeBreakpointRemoved,
                requestId = requestId,
                breakpointId = agentId
            )
        )
    }

    private fun notify(content: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("BreakPilot")
            .createNotification(content, NotificationType.INFORMATION)
            .notify(project)
    }
}
