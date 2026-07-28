package debugger

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class StackPaginationModelTest {
    @Test
    fun `provider completion and local limits remain distinct`() {
        assertEquals("complete", StackPaginationModel.completeness(1, true))
        assertEquals("partial", StackPaginationModel.completeness(1, true, locallyTruncated = true))
        assertEquals("partial", StackPaginationModel.completeness(2, false))
        assertEquals("unknown", StackPaginationModel.completeness(0, false))
        assertEquals(5, StackPaginationModel.nextOffset(3, 2, "partial"))
        assertNull(StackPaginationModel.nextOffset(3, 2, "complete"))
        assertNull(StackPaginationModel.nextOffset(3, 0, "partial"))
    }
}
