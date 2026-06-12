package ui

import bridge.BridgeMessage
import com.intellij.openapi.ui.Messages

data class ConfirmationChoice(
    val allowed: Boolean,
    val rememberScope: String = "once"
)

fun showBreakpointConfirmation(message: BridgeMessage): ConfirmationChoice {
    val riskLevel = message.riskLevel ?: "control"
    val actionKind = message.actionKind ?: "debug_control"
    val title = message.title ?: fallbackTitle(actionKind)
    val body = buildMessageBody(message)
    // Button sets mirror the server-provided risk model: safe can remember the
    // project, debug control can remember only this session, high risk is once.
    val buttons = when (riskLevel) {
        "safe" -> arrayOf("Allow Once", "Always Allow in This Project", "Deny")
        "control" -> arrayOf("Allow Once", "Allow for This Debug Session", "Deny")
        else -> arrayOf("Allow Once", "Deny")
    }
    val result = Messages.showDialog(
        body,
        title,
        buttons,
        0,
        if (riskLevel == "high") Messages.getWarningIcon() else Messages.getQuestionIcon()
    )

    return when {
        result < 0 -> ConfirmationChoice(false)
        buttons[result] == "Deny" -> ConfirmationChoice(false)
        // Keep scope derivation close to the exact button labels so future copy
        // changes do not accidentally persist broader consent than intended.
        buttons[result] == "Always Allow in This Project" -> ConfirmationChoice(true, "project")
        buttons[result] == "Allow for This Debug Session" -> ConfirmationChoice(true, "session")
        else -> ConfirmationChoice(true, "once")
    }
}

private fun fallbackTitle(actionKind: String): String {
    return when (actionKind) {
        "safe_inspection" -> "Allow BreakPilot to inspect the paused debug state?"
        "debug_control" -> "Allow BreakPilot to control this debug session?"
        "high_risk" -> "BreakPilot wants to run a high-risk debug action"
        else -> "Allow BreakPilot debug action?"
    }
}

private fun buildMessageBody(message: BridgeMessage): String {
    val lines = mutableListOf<String>()
    lines += message.description ?: "BreakPilot requests permission to run a debug action."
    lines += ""
    lines += "Action: ${message.action ?: "debug_action"}"
    lines += "Risk: ${message.riskLevel ?: "control"}"
    message.sessionName?.takeIf { it.isNotBlank() }?.let { lines += "Debug session: $it" }
    message.file?.takeIf { it.isNotBlank() }?.let { file ->
        val location = message.line?.let { "$file:$it" } ?: file
        lines += "Location: $location"
    }
    message.expressionPreview?.takeIf { it.isNotBlank() }?.let { lines += "Expression: $it" }
    return lines.joinToString("\n")
}
