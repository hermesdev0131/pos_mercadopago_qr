/** @odoo-module **/

import { PaymentMethodLine } from "@point_of_sale/app/screens/payment_screen/payment_method_line";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded");

patch(PaymentMethodLine.prototype, {

    setup() {
        this._super(...arguments);
        this.rpc = useService("rpc");
        this.notification = useService("notification");

        this.mpState = useState({
            status: "idle",   // idle | loading | pending | approved | error
            qr_url: null,
            payment_id: null,
            error: null,
        });
    },

    get isMercadoPago() {
        // paymentMethod is available in props in new POS
        const pm = this.paymentMethod || this.props.paymentMethod;
        return pm && pm.name === "MercadoPago";
    },

    async startMercadoPago() {
        if (!this.isMercadoPago || this.mpState.status === "pending") {
            return;
        }

        try {
            this.mpState.status = "loading";
            this.mpState.error = null;

            const order = this.env.pos.get_order();
            const amount = order.get_due(); // amount to pay with this method

            const result = await this.rpc("/mp/pos/create", {
                amount: amount,
                description: order.name || "POS Order",
                order_uid: order.uid,
            });

            if (result.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = result.details || "Error creating payment.";
                this.notification.add(this.mpState.error, { type: "danger" });
                return;
            }

            this.mpState.status = "pending";
            this.mpState.qr_url = result.qr_url;
            this.mpState.payment_id = result.payment_id;

            // Start polling
            this.pollStatus();
        } catch (err) {
            console.error("MercadoPago start error", err);
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error starting MercadoPago payment.";
            this.notification.add(this.mpState.error, { type: "danger" });
        }
    },

    async pollStatus() {
        if (!this.mpState.payment_id) {
            return;
        }

        try {
            const result = await this.rpc("/mp/pos/status", {
                payment_id: this.mpState.payment_id,
            });

            if (result.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = result.details || "Error checking payment status.";
                this.notification.add(this.mpState.error, { type: "danger" });
                return;
            }

            const payStatus = result.payment_status;
            if (payStatus === "approved") {
                this.mpState.status = "approved";
                this.notification.add("MercadoPago payment approved.", { type: "success" });

                // When approved, we can auto-validate the order from PaymentScreen,
                // but from here we just trust the cashier to press Validate.
            } else if (payStatus === "pending") {
                // continue polling
                setTimeout(() => this.pollStatus(), 3000);
            } else {
                this.mpState.status = "error";
                this.mpState.error = "Payment " + payStatus;
                this.notification.add(this.mpState.error, { type: "warning" });
            }
        } catch (err) {
            console.error("MercadoPago poll error", err);
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error checking payment.";
            this.notification.add(this.mpState.error, { type: "danger" });
        }
    },
});
