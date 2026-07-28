package debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.frame.XExecutionStack
import com.intellij.xdebugger.frame.XStackFrame

object StackPaginationModel {
    fun completeness(frameCount: Int, last: Boolean): String =
        if (last) "complete" else if (frameCount == 0) "unknown" else "partial"

    fun nextOffset(offset: Int, frameCount: Int, completeness: String): Int? =
        if (completeness == "partial" && frameCount > 0) offset + frameCount else null
}

class StackReader {
    fun read(
        session: XDebugSession,
        threadId: Int?,
        offset: Int,
        limit: Int,
        pauseEpoch: Long,
        callback: (Map<String, Any?>) -> Unit
    ) {
        val stacks = session.suspendContext?.executionStacks?.toList().orEmpty()
        val stack = stacks.firstOrNull { System.identityHashCode(it) == threadId }
            ?: session.suspendContext?.activeExecutionStack
        if (stack == null) {
            callback(page(threadId, emptyList(), offset, pauseEpoch, "unknown", "noSuspendContext"))
            return
        }
        val frames = mutableListOf<XStackFrame>()
        var finished = false
        fun finish(last: Boolean, reason: String? = null) {
            if (finished) return
            finished = true
            val selected = frames.take(limit.coerceAtLeast(0))
            val completeness = StackPaginationModel.completeness(selected.size, last)
            ApplicationManager.getApplication().invokeLater {
                callback(page(System.identityHashCode(stack), selected, offset, pauseEpoch, completeness, reason))
            }
        }
        stack.computeStackFrames(offset.coerceAtLeast(0), object : XExecutionStack.XStackFrameContainer {
            override fun addStackFrames(stackFrames: List<XStackFrame>, last: Boolean) {
                frames += stackFrames.take((limit - frames.size).coerceAtLeast(0))
                if (last || frames.size >= limit) finish(last, if (last) null else "limit")
            }

            override fun errorOccurred(errorMessage: String) = finish(false, "provider")
            override fun isObsolete(): Boolean = finished
        })
    }

    private fun page(
        threadId: Int?,
        frames: List<XStackFrame>,
        offset: Int,
        pauseEpoch: Long,
        completeness: String,
        reason: String?
    ): Map<String, Any?> {
        val mapped = frames.map { frame ->
            val position = frame.sourcePosition
            mapOf(
                "id" to System.identityHashCode(frame),
                "name" to frame.javaClass.simpleName,
                "line" to ((position?.line ?: -1) + 1),
                "column" to 1,
                "source" to mapOf("name" to position?.file?.name, "path" to position?.file?.path)
            )
        }
        return mapOf(
            "threadId" to threadId,
            "stackFrames" to mapped,
            "offset" to offset,
            "completeness" to completeness,
            "nextOffset" to StackPaginationModel.nextOffset(offset, mapped.size, completeness),
            "truncationReason" to reason,
            "pauseEpoch" to pauseEpoch
        )
    }
}
