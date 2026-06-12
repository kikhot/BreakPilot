package settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros

@Service(Service.Level.PROJECT)
@State(name = "BreakPilotProjectConsent", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class BreakPilotProjectConsentState : PersistentStateComponent<BreakPilotProjectConsentState.State> {
    data class State(
        var trustedProject: Boolean = false,
        var allowedSafeInspectionActions: MutableList<String> = mutableListOf()
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    fun allowSafeInspection(action: String) {
        if (!state.allowedSafeInspectionActions.contains(action)) {
            state.allowedSafeInspectionActions.add(action)
        }
    }

    fun isSafeInspectionAllowed(action: String): Boolean {
        return state.allowedSafeInspectionActions.contains(action)
    }

    fun resetProjectDecisions() {
        state.allowedSafeInspectionActions.clear()
    }

    fun resetAllProjectState() {
        state = State()
    }
}
