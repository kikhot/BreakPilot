package debugger

import com.intellij.xdebugger.frame.XValue
import java.util.UUID

data class IdeaHandleEntry(
    val sessionId: String,
    val pauseEpoch: Long,
    val value: XValue,
    val name: String,
    val frameKey: String?,
    val evaluateName: String?,
    val modifiable: Boolean
)

class PauseScopedHandleRegistry(private val maxEntries: Int = 2048) {
    private val entries = linkedMapOf<String, IdeaHandleEntry>()

    @Synchronized
    fun register(entry: IdeaHandleEntry): String {
        val handle = "bpref_${UUID.randomUUID()}"
        entries[handle] = entry
        while (entries.size > maxEntries.coerceAtLeast(1)) {
            entries.remove(entries.keys.first())
        }
        return handle
    }

    @Synchronized
    fun resolve(handle: String, sessionId: String, pauseEpoch: Long): IdeaHandleEntry? {
        val entry = entries[handle] ?: return null
        return entry.takeIf { it.sessionId == sessionId && it.pauseEpoch == pauseEpoch }
    }

    @Synchronized
    fun invalidate(sessionId: String) {
        entries.entries.removeIf { it.value.sessionId == sessionId }
    }
}
