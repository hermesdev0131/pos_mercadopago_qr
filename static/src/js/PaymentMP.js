/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded OK");

patch(PaymentScreen.prototype, {
    setup() {
        // 1. CRITICAL: Run the original setup first!
        // This initializes 'this.pos', 'this.ui', 'this.payment_methods', etc.
        // We use optional chaining (?.) to prevent crashes if it's missing.
        this._super?.(...arguments);

        // 2. Define OUR custom services (using unique names to avoid conflicts)
        this.mpOrm = useService("orm");
        this.mpNotification = useService("notification");
        
        // Note: We do NOT need to define 'this.ui' or 'this.pos' manually 
        // because _super() handles that for us now.

        // 3. Initialize our state
        this.mpState = useState({
            status: "idle",
            qr_url: null,
            payment_id: null,
            error: null,
        });
    },

    get isMercadoPago() {
        // Use 'this.pos' which is now available thanks to _super()
        const order = this.pos.get_order();
        if (!order) return false;

        const lines = order.paymentLines || order.payment_lines || [];
        const paymentLine = lines.find(line => line.selected);
        
        return paymentLine && paymentLine.payment_method && paymentLine.payment_method.name === "MercadoPago";
    },

    async startMercadoPago() {
        if (!this.isMercadoPago || this.mpState.status === "pending") return;

        try {
            this.mpState.status = "loading";
            const order = this.pos.get_order();
            const amount = order.get_due();
            
            const lines = order.paymentLines || order.payment_lines || [];
            const selectedLine = lines.find(line => line.selected);
            
            if (!selectedLine) return;

            const result = await this.mpOrm.call(
                "pos.payment.method", 
                "create_mp_payment", 
                [], 
                {
                    amount: amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: selectedLine.payment_method.id
                }
            );

            if (result.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = result.details;
                this.mpNotification.add(result.details, { type: "danger" });
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
        }
    },

    async pollStatus() {
        if (!this.mpState.payment_id) return;

        try {
            const result = await this.mpOrm.call(
                "pos.payment.method", 
                "check_mp_status", 
                [], 
                { payment_id: this.mpState.payment_id }
            );

            if (result.payment_status === "approved") {
                this.mpState.status = "approved";
                this.mpNotification.add("Payment approved", { type: "success" });
                
                const order = this.pos.get_order();
                const lines = order.paymentLines || order.payment_lines || [];
                const line = lines.find(l => l.selected);
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