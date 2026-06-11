public class Calculator {

    // Demo method. Set a breakpoint on line 5 (the assignment) to inspect
    // `amount`, `discount`, and `total` when the program stops here.
    static int calculateTotal(int amount, int discount) {
        int total = amount - discount;   // <-- breakpoint here (line 6)
        return total;
    }

    public static void main(String[] args) {
        int amount = 100;
        int discount = 30;
        int total = calculateTotal(amount, discount);
        System.out.println("total=" + total);
    }
}
