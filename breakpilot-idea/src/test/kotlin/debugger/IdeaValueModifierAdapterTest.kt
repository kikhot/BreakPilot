package debugger

import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValueModifier
import com.intellij.xdebugger.frame.XValueNode
import com.intellij.xdebugger.frame.XValuePlace
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class IdeaValueModifierAdapterTest {
    @Test
    fun `native setter verifies a read back in the same pause epoch`() {
        val modifier = RecordingModifier()
        val reads = ArrayDeque(listOf("41", "42"))
        var outcome: NativeMutationOutcome? = null

        IdeaValueModifierAdapter().setValue(entry(modifier), "42", 7, { 7 }, { done -> done(reads.removeFirst()) }) {
            outcome = it
        }

        assertEquals("42", modifier.value)
        assertEquals("41", assertNotNull(outcome).oldValue)
        assertTrue(assertNotNull(outcome).applied)
        assertTrue(assertNotNull(outcome).verified)
    }

    @Test
    fun `pause change before dispatch prevents native mutation`() {
        val modifier = RecordingModifier()
        var epoch = 7L
        var outcome: NativeMutationOutcome? = null

        IdeaValueModifierAdapter().setValue(entry(modifier), "42", 7, { epoch }, { done ->
            epoch = 8
            done("41")
        }) { outcome = it }

        assertEquals(0, modifier.calls)
        assertFalse(assertNotNull(outcome).applied)
        assertEquals("STALE_RUNTIME_HANDLE", assertNotNull(outcome).message)
    }

    @Test
    fun `pause change after dispatch reports applied but unverified`() {
        var epoch = 7L
        val modifier = RecordingModifier(onSet = { epoch = 8 })
        var outcome: NativeMutationOutcome? = null

        IdeaValueModifierAdapter().setValue(entry(modifier), "42", 7, { epoch }, { done -> done("41") }) {
            outcome = it
        }

        assertEquals(1, modifier.calls)
        assertTrue(assertNotNull(outcome).applied)
        assertFalse(assertNotNull(outcome).verified)
        assertEquals("STALE_RUNTIME_HANDLE", assertNotNull(outcome).message)
    }

    @Test
    fun `misbehaving modifier can complete the mutation only once`() {
        val modifier = RecordingModifier(afterSuccess = { callback -> callback.errorOccurred("late failure") })
        var callbacks = 0

        IdeaValueModifierAdapter().setValue(entry(modifier), "42", 7, { 7 }, { done -> done("42") }) {
            callbacks += 1
        }

        assertEquals(1, callbacks)
    }

    private fun entry(modifier: XValueModifier) =
        IdeaHandleEntry("session", 7, ModifiableValue(modifier), "score", "frame", "score", true)
}

private class ModifiableValue(private val valueModifier: XValueModifier) : XValue() {
    override fun getModifier(): XValueModifier = valueModifier

    override fun computePresentation(node: XValueNode, place: XValuePlace) {
        node.setPresentation(null, "int", "41", false)
    }
}

private class RecordingModifier(
    private val onSet: () -> Unit = {},
    private val afterSuccess: (XModificationCallback) -> Unit = {}
) : XValueModifier() {
    var calls = 0
    var value: String? = null

    @Suppress("DEPRECATION")
    override fun setValue(expression: String, callback: XModificationCallback) {
        calls += 1
        value = expression
        onSet()
        callback.valueModified()
        afterSuccess(callback)
    }
}
