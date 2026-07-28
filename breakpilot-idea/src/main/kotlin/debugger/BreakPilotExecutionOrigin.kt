package debugger

import com.intellij.openapi.util.Key

object BreakPilotExecutionOrigin {
    val key: Key<String> = Key.create("breakpilot.originRequestId")
}
