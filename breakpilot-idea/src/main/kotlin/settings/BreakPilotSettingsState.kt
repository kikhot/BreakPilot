package settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@Service(Service.Level.APP)
@State(name = "BreakPilotSettings", storages = [Storage("breakpilot.xml")])
class BreakPilotSettingsState : PersistentStateComponent<BreakPilotSettingsState.State> {
    data class State(
        var safeInspectionsMode: String = SafeInspectionsMode.AskOncePerProject.id,
        var debugControlsMode: String = DebugControlsMode.AskOncePerSession.id,
        var allowPersistentHighRiskApprovals: Boolean = false,
        var allowedActions: MutableList<String> = mutableListOf("readonly_evaluate"),
        var allowedExpressionPatterns: MutableList<String> = mutableListOf(),
        var allowlistTrustedProjectsOnly: Boolean = true
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    fun resetAll() {
        state = State()
    }
}

enum class SafeInspectionsMode(val id: String, val label: String) {
    AskOncePerProject("ask_once_per_project", "Ask once per project"),
    AlwaysAsk("always_ask", "Always ask"),
    AlwaysAllowTrustedProjects("always_allow_trusted_projects", "Always allow in trusted projects");

    override fun toString(): String = label

    companion object {
        fun fromId(id: String?): SafeInspectionsMode = entries.firstOrNull { it.id == id } ?: AskOncePerProject
    }
}

enum class DebugControlsMode(val id: String, val label: String) {
    AskOncePerSession("ask_once_per_session", "Ask once per debug session"),
    AlwaysAsk("always_ask", "Always ask");

    override fun toString(): String = label

    companion object {
        fun fromId(id: String?): DebugControlsMode = entries.firstOrNull { it.id == id } ?: AskOncePerSession
    }
}
