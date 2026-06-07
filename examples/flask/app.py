import os

from flask import Flask, jsonify, request

app = Flask(__name__)


def calculate_total(order):
    amount = order.get("amount", 0)
    discount = order.get("discount", 0)
    # Intentional demo bug: discount may arrive as a string.
    return amount - discount


@app.post("/order")
def create_order():
    order = request.get_json(force=True)
    total = calculate_total(order)
    return jsonify({"total": total})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5000")), debug=False)
