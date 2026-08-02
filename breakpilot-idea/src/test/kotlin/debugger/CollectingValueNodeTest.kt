package debugger

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CollectingValueNodeTest {
    @Test
    fun `empty expandable presentation waits for a later completed value`() {
        val completed = mutableListOf<PresentationData>()
        val node = CollectingValueNode(2000, completed::add) { action -> action() }

        node.setPresentation(null, "byte[]@1", "", true)

        assertFalse(node.isObsolete())
        assertTrue(completed.isEmpty())

        node.setPresentation(null, "byte[3]@1", "[1, 2, 3]", true)
        node.setPresentation(null, "byte[3]@1", "late duplicate", true)

        assertTrue(node.isObsolete())
        assertEquals(1, completed.size)
        assertEquals("[1, 2, 3]", completed.single().valuePreview)
        assertEquals("byte[3]@1", completed.single().type)
    }

    @Test
    fun `presentation timeout returns the latest provisional value exactly once`() {
        val completed = mutableListOf<PresentationData>()
        val node = CollectingValueNode(2000, completed::add) { action -> action() }

        node.setPresentation(null, "byte[]@1", "", true)
        node.setPresentation(null, "byte[3]@1", "", true)
        node.finishUnavailable("presentation timeout")
        node.setPresentation(null, "byte[3]@1", "late value", true)

        assertEquals(1, completed.size)
        assertEquals("", completed.single().valuePreview)
        assertEquals("byte[3]@1", completed.single().type)
        assertEquals("presentation timeout", completed.single().presentationError)
    }

    @Test
    fun `collecting placeholder still times out as unavailable`() {
        val completed = mutableListOf<PresentationData>()
        val node = CollectingValueNode(2000, completed::add) { action -> action() }

        node.setPresentation(null, "String", "Collecting data...", true)
        node.finishUnavailable("presentation timeout")

        assertEquals(1, completed.size)
        assertEquals("<unavailable>", completed.single().valuePreview)
        assertEquals("presentation timeout", completed.single().presentationError)
    }
}
