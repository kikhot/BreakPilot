package plugin

import bridge.BridgeClient
import debugger.BreakpointSync
import debugger.CommandExecutor
import ui.showBreakpointConfirmation
import com.intellij.openapi.components.ProjectComponent
import com.intellij.openapi.project.Project

class DebugMcpIdeaPlugin(private val project: Project) : ProjectComponent {
    private val bridge = BridgeClient(project)
    private val breakpoints = BreakpointSync(project, bridge)
    private val commands = CommandExecutor(project)

    override fun projectOpened() {
        bridge.onMessage { message ->
            breakpoints.handle(message)
            commands.handle(message)
            if (message.type == "agent_request_confirmation") {
                showBreakpointConfirmation(bridge, message)
            }
        }
        bridge.connect()
    }
}
