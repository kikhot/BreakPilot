package debugger

import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValueNode
import com.intellij.xdebugger.frame.XValuePlace
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PauseScopedHandleRegistryTest {
    @Test
    fun `handle resolves only in original session and epoch`() {
        val registry = PauseScopedHandleRegistry(maxEntries = 2)
        val ref = registry.register(
            IdeaHandleEntry("session", 3, FakeValue(), "score", "frame", "score", true)
        )
        assertTrue(ref.startsWith("bpref_"))
        assertNotNull(registry.resolve(ref, "session", 3))
        assertNull(registry.resolve(ref, "session", 4))
        assertNull(registry.resolve(ref, "other", 3))
        registry.invalidate("session")
        assertNull(registry.resolve(ref, "session", 3))
    }
}

private class FakeValue : XValue() {
    override fun computePresentation(node: XValueNode, place: XValuePlace) {
        node.setPresentation(null, "int", "41", false)
    }
}
