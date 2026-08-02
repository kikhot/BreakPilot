package debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.frame.XExecutionStack
import com.intellij.xdebugger.frame.XStackFrame
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

object StackPaginationModel {
    fun completeness(frameCount: Int, last: Boolean, locallyTruncated: Boolean = false): String =
        if (last && !locallyTruncated) "complete" else if (frameCount == 0) "unknown" else "partial"

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
        val completionLock = Any()
        var finished = false
        var timeout: ScheduledFuture<*>? = null
        fun finish(last: Boolean, reason: String? = null, locallyTruncated: Boolean = false) {
            val selected = synchronized(completionLock) {
                if (finished) return
                finished = true
                frames.take(limit.coerceAtLeast(0))
            }
            timeout?.cancel(false)
            val completeness = StackPaginationModel.completeness(selected.size, last, locallyTruncated)
            ApplicationManager.getApplication().invokeLater {
                callback(page(System.identityHashCode(stack), selected, offset, pauseEpoch, completeness, reason))
            }
        }
        timeout = AppExecutorUtil.getAppScheduledExecutorService().schedule(
            { finish(false, "timeout") },
            5,
            TimeUnit.SECONDS
        )
        stack.computeStackFrames(offset.coerceAtLeast(0), object : XExecutionStack.XStackFrameContainer {
            override fun addStackFrames(stackFrames: List<XStackFrame>, last: Boolean) {
                synchronized(completionLock) {
                    if (finished) return
                    val remaining = (limit - frames.size).coerceAtLeast(0)
                    val locallyTruncated = stackFrames.size > remaining
                    frames += stackFrames.take(remaining)
                    if (last || frames.size >= limit) {
                        finish(last, if (locallyTruncated || !last) "limit" else null, locallyTruncated || !last)
                    }
                }
            }

            override fun errorOccurred(errorMessage: String) = finish(false, "provider")
            override fun isObsolete(): Boolean = synchronized(completionLock) { finished }
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
            val displayName = StackFramePresentationReader.semanticName(frame)
            mapOf(
                "id" to System.identityHashCode(frame),
                "name" to displayName,
                "displayName" to displayName,
                "function" to displayName,
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
