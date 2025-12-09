/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded OK");

patch(PaymentScreen.prototype, {
    setup() {
        // Essential services
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.ui = useService("ui");
        
        // Ensure POS service is available (Critical for currentOrder)
        this.pos = useService("pos"); 

        this.mpState = useState({
            status: "idle",
            qr_url: null,
            payment_id: null,
            error: null,
        });
    },

    get isMercadoPago() {
        // Defensive check: Ensure order exists
        const order = this.currentOrder;
        if (!order) return false;

        // Check for payment lines (handle different property names in Odoo versions)
        const lines = order.paymentLines || order.payment_lines || [];
        const paymentLine = lines.find(line => line.selected);
        
        return paymentLine && paymentLine.payment_method && paymentLine.payment_method.name === "MercadoPago";
    },

    get currentOrder() {
        // Explicit getter to ensure we always get the active order
        return this.pos.get_order();
    },

    async startMercadoPago() {
        if (!this.isMercadoPago || this.mpState.status === "pending") return;

        try {
            this.mpState.status = "loading";
            const order = this.currentOrder;
            const amount = order.get_due();
            
            // Get selected line safely
            const lines = order.paymentLines || order.payment_lines || [];
            const selectedLine = lines.find(line => line.selected);
            
            if (!selectedLine) return;

            const result = await this.orm.call(
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
        }
    },

    async pollStatus() {
        if (!this.mpState.payment_id) return;

        try {
            const result = await this.orm.call(
                "pos.payment.method", 
                "check_mp_status", 
                [], 
                { payment_id: this.mpState.payment_id }
            );

            if (result.payment_status === "approved") {
                this.mpState.status = "approved";
                this.notification.add("Payment approved", { type: "success" });
                
                const lines = this.currentOrder.paymentLines || this.currentOrder.payment_lines || [];
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