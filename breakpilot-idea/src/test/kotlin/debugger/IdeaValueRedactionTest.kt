package debugger

import kotlin.test.Test
import kotlin.test.assertEquals

class IdeaValueRedactionTest {
    @Test
    fun `matching names or values are redacted`() {
        assertEquals("[redacted]", IdeaValueRedaction.redact("accessToken", "visible", listOf("(?i)token")))
        assertEquals("[redacted]", IdeaValueRedaction.redact("message", "Bearer abc", listOf("Bearer\\s+")))
        assertEquals("ordinary", IdeaValueRedaction.redact("message", "ordinary", listOf("(?i)token")))
        assertEquals(true, IdeaValueRedaction.shouldRedact("accessToken", "[redacted]", listOf("(?i)token")))
    }

    @Test
    fun `invalid regex falls back to literal matching`() {
        assertEquals("[redacted]", IdeaValueRedaction.redact("field", "prefix[secret", listOf("[secret")))
        assertEquals("ordinary", IdeaValueRedaction.redact("field", "ordinary", listOf("[secret")))
    }
}
