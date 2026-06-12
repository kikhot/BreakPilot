package plugin

import bridge.BridgeClient
import debugger.BreakpointSync
import debugger.CommandExecutor
import debugger.IdeSessionTracker
import debugger.VariableReader
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import security.ConsentManager

class BreakPilotIdeaPlugin : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        project.service<BreakPilotIdeaProjectService>()
    }
}

@Service(Service.Level.PROJECT)
class BreakPilotIdeaProjectService(private val project: Project) : Disposable {
    private val bridge = BridgeClient(project)
    private val consentManager = project.service<ConsentManager>()
    private val tracker = IdeSessionTracker(project, bridge) { consentManager.clearSession(it) }
    private val variableReader = VariableReader(project, tracker)
    private val breakpoints = BreakpointSync(project, bridge)
    private val commands = CommandExecutor(project, bridge, tracker, variableReader)

    init {
        bridge.onMessage { message ->
            breakpoints.handle(message)
            commands.handle(message)
            if (message.type == "agent_request_variables") {
                variableReader.handle(message, bridge)
            }
            if (message.type == "agent_request_confirmation") {
                consentManager.handleConfirmation(bridge, message)
            }
        }
        tracker.start()
        bridge.connect()
    }

    override fun dispose() {
        bridge.dispose()
    }
}
