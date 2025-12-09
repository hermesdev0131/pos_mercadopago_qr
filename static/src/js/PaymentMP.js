/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded OK");

const originalSetup = PaymentScreen.prototype.setup;

patch(PaymentScreen.prototype, {
    setup() {
        originalSetup.call(this);
        
        this.rpc = this.env.services.rpc;
        this.notification = this.env.services.notification;

        this.mpState = useState({
            status: "idle",
            qr_url: null,
            payment_id: null,
            error: null,
        });
    },

    // Helper to identify if the currently selected payment method is MP
    get isMercadoPago() {
        const paymentLine = this.currentOrder.paymentLines.find(line => line.selected);
        return paymentLine && paymentLine.payment_method.name === "MercadoPago";
    },

    // Triggered by your custom button click in the XML
    async startMercadoPago() {
        // ... (Your existing logic matches perfectly here)
        if (!this.isMercadoPago || this.mpState.status === "pending") {
            return;
        }

        try {
            this.mpState.status = "loading";
            // Use this.currentOrder which is available in PaymentScreen
            const order = this.currentOrder; 
            const amount = order.get_due();

            const result = await this.rpc("/mp/pos/create", {
                amount,
                description: order.name,
                order_uid: order.uid,
                pos_client_ref: order.name // Ensure unique ref
            });

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
            this.notification.add("Error connecting to MercadoPago", { type: "danger" });
        }
    },

    async pollStatus() {
        // ... (Your polling logic is correct)
        if (!this.mpState.payment_id) return;

        try {
            const result = await this.rpc("/mp/pos/status", {
                payment_id: this.mpState.payment_id,
            });

            if (result.payment_status === "approved") {
                this.mpState.status = "approved";
                this.notification.add("Payment approved", { type: "success" });
                // Optional: Automatically validate the payment line here
                // this.currentOrder.selected_paymentline.set_payment_status('done');
                return;
            }

            if (result.payment_status === "pending") {
                setTimeout(() => this.pollStatus(), 2000);
            } else {
                this.mpState.status = "error";
                this.mpState.error = "Payment " + result.payment_status;
            }
        } catch (e) {
            console.error("Polling error", e);
        }
    },
});