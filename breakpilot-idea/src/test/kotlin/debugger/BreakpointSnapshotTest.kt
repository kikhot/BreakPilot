package debugger

import kotlin.test.Test
import kotlin.test.assertEquals

class BreakpointSnapshotTest {
    @Test
    fun `native breakpoint semantics survive bridge snapshot projection`() {
        val snapshot = breakpointSemanticsSnapshot(
            enabled = false,
            condition = "order.total > 100",
            suspendPolicy = "THREAD",
            temporary = true,
            logMessage = "order={order.id}",
            isLogMessage = true,
            isLogStack = true
        )

        assertEquals(
            mapOf(
                "enabled" to false,
                "verified" to true,
                "condition" to "order.total > 100",
                "suspendPolicy" to "THREAD",
                "temporary" to true,
                "logMessage" to "order={order.id}",
                "isLogMessage" to true,
                "isLogStack" to true
            ),
            snapshot
        )
    }

    @Test
    fun `snapshot id keeps agent ids and derives exact native ids`() {
        assertEquals(
            "bp_agent_1",
            breakpointSnapshotId(
                agentId = "bp_agent_1",
                breakpointClassName = "JavaLineBreakpoint",
                index = 4,
                fileUrl = "file:///workspace/App.java",
                zeroBasedLine = 20
            )
        )
        assertEquals(
            "line|file:///workspace/App.java|20",
            breakpointSnapshotId(
                agentId = null,
                breakpointClassName = "JavaLineBreakpoint",
                index = 4,
                fileUrl = "file:///workspace/App.java",
                zeroBasedLine = 20
            )
        )
        assertEquals(
            "JavaExceptionBreakpoint|2",
            breakpointSnapshotId(
                agentId = null,
                breakpointClassName = "JavaExceptionBreakpoint",
                index = 2
            )
        )
    }
}
