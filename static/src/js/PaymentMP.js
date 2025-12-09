/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded OK");

patch(PaymentScreen.prototype, {
    setup() {
        // IMPORTANT: keep the original logic
        super.setup(...arguments);

        // Extra services just for our module
        this.mpOrm = useService("orm");
        this.mpNotification = useService("notification");

        // Local reactive state for MercadoPago
        this.mpState = useState({
            status: "idle",
            qr_url: null,
            payment_id: null,
            error: null,
        });
    },

    get isMercadoPago() {
        // Use the PaymentScreen API from Odoo
        const order = this.currentOrder;
        if (!order) {
            return false;
        }

        // Try both shapes, depending on POS version
        const lines =
            order.paymentLines ||
            order.payment_lines ||
            [];

        const paymentLine = lines.find((line) => line.selected);

        return (
            paymentLine &&
            paymentLine.payment_method &&
            paymentLine.payment_method.name === "MercadoPago"
        );
    },

    async startMercadoPago() {
        if (!this.isMercadoPago || this.mpState.status === "pending") {
            return;
        }

        try {
            this.mpState.status = "loading";
            this.mpState.error = null;

            const order = this.currentOrder;
            if (!order) {
                this.mpState.status = "error";
                this.mpState.error = "No current order.";
                return;
            }

            const amount = order.get_due
                ? order.get_due()
                : order.get_total_with_tax
                ? order.get_total_with_tax()
                : 0;

            const lines =
                order.paymentLines ||
                order.payment_lines ||
                [];
            const selectedLine = lines.find((line) => line.selected);
            if (!selectedLine) {
                this.mpState.status = "error";
                this.mpState.error = "No selected payment line.";
                return;
            }

            const result = await this.mpOrm.call(
                "pos.payment.method",
                "create_mp_payment",
                [],
                {
                    amount: amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: selectedLine.payment_method.id,
                }
            );

            if (!result || result.status !== "success") {
                const msg =
                    (result && result.details) || "Error creating MercadoPago payment.";
                this.mpState.status = "error";
                this.mpState.error = msg;
                this.mpNotification.add(msg, { type: "danger" });
                return;
            }

            this.mpState.status = "pending";
            this.mpState.qr_url = result.qr_data;
            this.mpState.payment_id = result.payment_id;

            this.pollStatus();
        } catch (err) {
            console.error("MercadoPago error:", err);
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error in MercadoPago.";
            this.mpNotification.add(this.mpState.error, { type: "danger" });
        }
    },

    async pollStatus() {
        if (!this.mpState.payment_id) {
            return;
        }

        try {
            const result = await this.mpOrm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpState.payment_id }
            );

            if (!result || !result.payment_status) {
                this.mpState.status = "error";
                this.mpState.error = "Unknown MercadoPago status.";
                return;
            }

            if (result.payment_status === "approved") {
                this.mpState.status = "approved";
                this.mpNotification.add("MercadoPago payment approved", {
                    type: "success",
                });

                const order = this.currentOrder;
                if (order) {
                    const lines =
                        order.paymentLines ||
                        order.payment_lines ||
                        [];
                    const line = lines.find((l) => l.selected);
                    if (line && line.set_payment_status) {
                        line.set_payment_status("done");
                    }
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
            this.mpState.status = "error";
            this.mpState.error = "Error checking MercadoPago status.";
        }
    },
});
