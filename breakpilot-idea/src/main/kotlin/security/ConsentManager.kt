package security

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import settings.BreakPilotProjectConsentState
import settings.BreakPilotSettingsState
import settings.DebugControlsMode
import settings.SafeInspectionsMode
import ui.showBreakpointConfirmation

@Service(Service.Level.PROJECT)
class ConsentManager(private val project: Project) {
    // Session-level consent is intentionally memory-only. A fresh debug session
    // should ask again because continue/step/stop affect the user's live flow.
    private val sessionAllowedActions = mutableMapOf<String, MutableSet<String>>()

    fun handleConfirmation(bridge: BridgeClient, message: BridgeMessage) {
        // Prefer an existing decision before showing UI. The server still sees a
        // normal confirmation response, so audit/control flow stays unchanged.
        val autoScope = automaticRememberScope(message)
        if (autoScope != null) {
            sendAllow(bridge, message, autoScope)
            return
        }

        val choice = showBreakpointConfirmation(message)
        if (!choice.allowed) {
            sendReject(bridge, message)
            return
        }

        remember(message, choice.rememberScope)
        sendAllow(bridge, message, choice.rememberScope)
    }

    fun clearSession(ideSessionId: String) {
        sessionAllowedActions.remove(ideSessionId)
    }

    fun resetSessionDecisions() {
        sessionAllowedActions.clear()
    }

    private fun automaticRememberScope(message: BridgeMessage): String? {
        // Risk level is supplied by the runtime policy layer; IDEA only decides
        // whether the user has already granted the permitted remember scope.
        val risk = message.riskLevel ?: "control"
        val action = message.action ?: return null
        return when (risk) {
            "safe" -> safeInspectionScope(action)
            "control" -> debugControlScope(message.ideSessionId, action)
            "high" -> highRiskAllowlistScope(message)
            else -> null
        }
    }

    private fun safeInspectionScope(action: String): String? {
        val settings = service<BreakPilotSettingsState>().state
        val projectConsent = project.service<BreakPilotProjectConsentState>()
        // Safe inspection can be remembered at project scope because it reads
        // paused state without resuming or mutating the debuggee.
        return when (SafeInspectionsMode.fromId(settings.safeInspectionsMode)) {
            SafeInspectionsMode.AlwaysAsk -> null
            SafeInspectionsMode.AlwaysAllowTrustedProjects ->
                if (projectConsent.state.trustedProject) "project" else null
            SafeInspectionsMode.AskOncePerProject ->
                if (projectConsent.isSafeInspectionAllowed(action)) "project" else null
        }
    }

    private fun debugControlScope(ideSessionId: String?, action: String): String? {
        val settings = service<BreakPilotSettingsState>().state
        if (DebugControlsMode.fromId(settings.debugControlsMode) == DebugControlsMode.AlwaysAsk) return null
        val key = ideSessionId ?: return null
        return if (sessionAllowedActions[key]?.contains(action) == true) "session" else null
    }

    private fun highRiskAllowlistScope(message: BridgeMessage): String? {
        val settings = service<BreakPilotSettingsState>().state
        if (!settings.allowPersistentHighRiskApprovals) return null
        val projectConsent = project.service<BreakPilotProjectConsentState>().state
        if (settings.allowlistTrustedProjectsOnly && !projectConsent.trustedProject) return null

        // Persistent high-risk approval is never broad by default. It requires
        // the advanced setting plus a narrow action or expression allowlist hit.
        val action = message.action.orEmpty()
        if (settings.allowedActions.contains(action)) return "project"

        val expression = (message.payload["expression"] as? String) ?: message.expressionPreview.orEmpty()
        return if (settings.allowedExpressionPatterns.any { patternMatches(it, expression) }) "project" else null
    }

    private fun patternMatches(pattern: String, value: String): Boolean {
        if (pattern.isBlank() || value.isBlank()) return false
        return try {
            Regex(pattern).containsMatchIn(value)
        } catch (_: Throwable) {
            // Invalid regex entries degrade to simple substring matching so a
            // typo does not break the settings page or confirmation flow.
            value.contains(pattern)
        }
    }

    private fun remember(message: BridgeMessage, scope: String) {
        val action = message.action ?: return
        when (scope) {
            "project" -> if (message.riskLevel == "safe") {
                project.service<BreakPilotProjectConsentState>().allowSafeInspection(action)
            }
            "session" -> {
                val key = message.ideSessionId ?: return
                sessionAllowedActions.getOrPut(key) { mutableSetOf() }.add(action)
            }
        }
    }

    private fun sendAllow(bridge: BridgeClient, message: BridgeMessage, rememberScope: String) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.UserConfirmContinue,
                confirmationId = message.confirmationId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch,
                action = message.action ?: "allow",
                rememberScope = rememberScope
            )
        )
    }

    private fun sendReject(bridge: BridgeClient, message: BridgeMessage) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.UserRejectContinue,
                confirmationId = message.confirmationId,
                sessionId = message.sessionId,
                ideSessionId = message.ideSessionId,
                originRequestId = message.originRequestId,
                pauseEpoch = message.expectedPauseEpoch
            )
        )
    }
}
