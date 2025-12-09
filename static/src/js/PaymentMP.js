/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded OK");

patch(PaymentScreen.prototype, {
    setup() {
        console.log("PaymentScreen.setup patched, initializing MercadoPago");
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
        console.log("MercadoPago state initialized");
    },

    get isMercadoPago() {
        // Use the PaymentScreen API from Odoo
        const order = this.currentOrder;
        if (!order) {
            console.log("isMercadoPago: No current order");
            return false;
        }

        // Try both shapes, depending on POS version
        const lines =
            order.paymentLines ||
            order.payment_lines ||
            [];

        const paymentLine = lines.find((line) => line.selected);

        const result = (
            paymentLine &&
            paymentLine.payment_method &&
            paymentLine.payment_method.name === "MercadoPago"
        );
        console.log("isMercadoPago check:", { result, hasSeletedLine: !!paymentLine, methodName: paymentLine?.payment_method?.name });
        return result;
    },

    async startMercadoPago() {
        console.log("startMercadoPago called, isMercadoPago:", this.isMercadoPago, "status:", this.mpState.status);
        if (!this.isMercadoPago || this.mpState.status === "pending") {
            console.log("Conditions not met, returning");
            return;
        }

        try {
            console.log("Starting MercadoPago payment");
            this.mpState.status = "loading";
            this.mpState.error = null;

            const order = this.currentOrder;
            if (!order) {
                console.log("No current order");
                this.mpState.status = "error";
                this.mpState.error = "No current order.";
                return;
            }

            const amount = order.get_due
                ? order.get_due()
                : order.get_total_with_tax
                ? order.get_total_with_tax()
                : 0;

            console.log("Order amount:", amount);

            const lines =
                order.paymentLines ||
                order.payment_lines ||
                [];
            const selectedLine = lines.find((line) => line.selected);
            if (!selectedLine) {
                console.log("No selected line");
                this.mpState.status = "error";
                this.mpState.error = "No selected payment line.";
                return;
            }

            console.log("Calling create_mp_payment with:", { 
                amount, 
                description: order.name,
                payment_method_id: selectedLine.payment_method.id 
            });

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

            console.log("create_mp_payment result:", result);

            if (!result || result.status !== "success") {
                const msg =
                    (result && result.details) || "Error creating MercadoPago payment.";
                console.log("Payment creation failed:", msg);
                this.mpState.status = "error";
                this.mpState.error = msg;
                this.mpNotification.add(msg, { type: "danger" });
                return;
            }

            this.mpState.status = "pending";
            this.mpState.qr_url = result.qr_data;
            this.mpState.payment_id = result.payment_id;

            console.log("Payment pending, starting poll", { qr_url: this.mpState.qr_url, payment_id: this.mpState.payment_id });

            this.pollStatus();
        } catch (err) {
            console.error("MercadoPago error:", err);
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error in MercadoPago.";
            this.mpNotification.add(this.mpState.error, { type: "danger" });
        }
    },

    async pollStatus() {
        console.log("pollStatus called, payment_id:", this.mpState.payment_id);
        if (!this.mpState.payment_id) {
            console.log("No payment_id, returning");
            return;
        }

        try {
            console.log("Checking payment status");
            const result = await this.mpOrm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpState.payment_id }
            );

            console.log("check_mp_status result:", result);

            if (!result || !result.payment_status) {
                console.log("Invalid result from check_mp_status");
                this.mpState.status = "error";
                this.mpState.error = "Unknown MercadoPago status.";
                return;
            }

            if (result.payment_status === "approved") {
                console.log("Payment approved!");
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
                console.log("Payment still pending, will check again in 3s");
                setTimeout(() => this.pollStatus(), 3000);
            } else {
                console.log("Payment failed with status:", result.payment_status);
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
