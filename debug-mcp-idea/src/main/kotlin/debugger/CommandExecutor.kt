package debugger

import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.XDebuggerManager

class CommandExecutor(private val project: Project) {
    fun handle(message: BridgeMessage) {
        val session = XDebuggerManager.getInstance(project).currentSession ?: return
        when (message.type) {
            MessageTypes.AgentContinue -> session.resume()
            "agent_step_over" -> session.stepOver(false)
            "agent_step_into" -> session.stepInto()
            "agent_step_out" -> session.stepOut()
        }
    }
}
