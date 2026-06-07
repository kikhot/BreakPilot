package ui

import bridge.BridgeClient
import bridge.BridgeMessage
import bridge.MessageTypes
import com.intellij.openapi.ui.Messages

fun showBreakpointConfirmation(bridge: BridgeClient, message: BridgeMessage) {
    val result = Messages.showDialog(
        "AI Debugger hit a breakpoint and wants to inspect variables.",
        "AI Debugger",
        arrayOf("View Variables", "Let AI Analyze", "Continue", "Step Over", "Stop Debug"),
        2,
        Messages.getQuestionIcon()
    )
    if (result == 2 || result == 3) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.UserConfirmContinue,
                sessionId = message.sessionId,
                payload = mapOf(
                    "confirmationId" to message.payload["confirmationId"],
                    "action" to if (result == 2) "continue" else "step_over"
                )
            )
        )
    } else if (result == -1) {
        bridge.send(
            BridgeMessage(
                type = MessageTypes.UserRejectContinue,
                sessionId = message.sessionId,
                payload = mapOf("confirmationId" to message.payload["confirmationId"])
            )
        )
    }
}
