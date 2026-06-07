package debugger

import bridge.AgentBreakpoint
import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XBreakpoint
import com.intellij.xdebugger.breakpoints.XLineBreakpointType

class BreakpointSync(
    private val project: Project,
    private val bridge: BridgeClient
) {
    private val byAgentId = mutableMapOf<String, XBreakpoint<*>>()

    fun handle(message: BridgeMessage) {
        when (message.type) {
            MessageTypes.AgentSetBreakpoint -> message.breakpoint?.let { addAgentBreakpoint(it) }
            MessageTypes.AgentRemoveBreakpoint -> message.breakpointId?.let { removeAgentBreakpoint(it) }
        }
    }

    private fun addAgentBreakpoint(breakpoint: AgentBreakpoint) {
        val file = LocalFileSystem.getInstance().findFileByPath(breakpoint.file) ?: return
        val manager = XDebuggerManager.getInstance(project).breakpointManager
        val type = XLineBreakpointType.EXTENSION_POINT_NAME.extensionList.firstOrNull() ?: return
        val lineBreakpoint = manager.addLineBreakpoint(type, file.url, breakpoint.line - 1, null)
        byAgentId[breakpoint.id] = lineBreakpoint
        bridge.send(
            BridgeMessage(
                type = MessageTypes.IdeBreakpointAdded,
                breakpointId = breakpoint.id,
                breakpoint = breakpoint
            )
        )
    }

    private fun removeAgentBreakpoint(agentId: String) {
        val breakpoint = byAgentId.remove(agentId) ?: return
        XDebuggerManager.getInstance(project).breakpointManager.removeBreakpoint(breakpoint)
    }
}
