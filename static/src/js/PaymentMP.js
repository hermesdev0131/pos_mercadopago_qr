/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded OK");

patch(PaymentScreen.prototype, {
    setup() {
        // removed this._super to fix the previous TypeError
        this.orm = useService("orm"); // <--- CHANGED from 'rpc' to 'orm'
        this.notification = useService("notification");

        this.mpState = useState({
            status: "idle",
            qr_url: null,
            payment_id: null,
            error: null,
        });
    },

    get isMercadoPago() {
        const paymentLine = this.currentOrder.paymentLines.find(line => line.selected);
        // Ensure this matches the exact name in Odoo Backend -> POS -> Payment Methods
        return paymentLine && paymentLine.payment_method.name === "MercadoPago";
    },

    async startMercadoPago() {
        if (!this.isMercadoPago || this.mpState.status === "pending") {
            return;
        }

        try {
            this.mpState.status = "loading";
            const order = this.currentOrder;
            const amount = order.get_due();
            
            // Get the ID of the payment method to pass to backend
            const payment_method_id = order.paymentLines.find(line => line.selected).payment_method.id;

            // USE ORM CALL INSTEAD OF RPC ROUTE
            const result = await this.orm.call(
                "pos.payment.method",        // Model Name
                "create_mp_payment",         // Method Name
                [],                          // Positional Args (empty)
                {                            // Keyword Args (kwargs)
                    amount: amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: payment_method_id
                }
            );

            if (result.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = result.details;
                this.notification.add(result.details, { type: "danger" });
                return;
            }

            this.mpState.status = "pending";
            this.mpState.qr_url = result.qr_data;
            this.mpState.payment_id = result.payment_id;

            this.pollStatus();

        } catch (err) {
            console.error("MercadoPago error:", err);
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error";
            this.notification.add("Connection Error", { type: "danger" });
        }
    },

    async pollStatus() {
        if (!this.mpState.payment_id) return;

        try {
            // USE ORM CALL FOR STATUS CHECK
            const result = await this.orm.call(
                "pos.payment.method", 
                "check_mp_status", 
                [], 
                { payment_id: this.mpState.payment_id }
            );

            if (result.payment_status === "approved") {
                this.mpState.status = "approved";
                this.notification.add("Payment approved", { type: "success" });
                
                // Optional: Auto-validate the payment line
                const line = this.currentOrder.paymentLines.find(l => l.selected);
                if (line) {
                    line.set_payment_status('done');
                }
                return;
            }

            if (result.payment_status === "pending") {
                setTimeout(() => this.pollStatus(), 3000);
            } else {
                this.mpState.status = "error";
                this.mpState.error = "Payment " + result.payment_status;
            }
        } catch (e) {
            console.error("Polling error", e);
        }
    },
});