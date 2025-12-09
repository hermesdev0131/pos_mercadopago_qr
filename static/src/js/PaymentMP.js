/** @odoo-module **/

import { PaymentLines } from "@point_of_sale/app/screens/payment_screen/payment_lines/payment_lines";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";

console.log("MercadoPago POS Module Loaded OK");

patch(PaymentMethodLine.prototype, {

    setup() {
        this._super(...arguments);
        this.rpc = useService("rpc");
        this.notification = useService("notification");

        this.mpState = useState({
            status: "idle",
            qr_url: null,
            payment_id: null,
            error: null,
        });
    },

    get isMercadoPago() {
        const pm = this.paymentMethod || this.props.paymentMethod;
        return pm && pm.name === "MercadoPago";
    },

    async startMercadoPago() {
        if (!this.isMercadoPago || this.mpState.status === "pending") {
            return;
        }

        try {
            this.mpState.status = "loading";

            const order = this.env.pos.get_order();
            const amount = order.get_due();

            const result = await this.rpc("/mp/pos/create", {
                amount,
                description: order.name,
                order_uid: order.uid,
            });

            if (result.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = result.details;
                this.notification.add(result.details, { type: "danger" });
                return;
            }

            this.mpState.status = "pending";
            this.mpState.qr_url = result.qr_url;
            this.mpState.payment_id = result.payment_id;

            this.pollStatus();

        } catch (err) {
            console.error("MercadoPago error:", err);
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error";
            this.notification.add("Unexpected error", { type: "danger" });
        }
    },

    async pollStatus() {
        if (!this.mpState.payment_id) {
            return;
        }

        const result = await this.rpc("/mp/pos/status", {
            payment_id: this.mpState.payment_id,
        });

        if (result.payment_status === "approved") {
            this.mpState.status = "approved";
            this.notification.add("Payment approved", { type: "success" });
            return;
        }

        if (result.payment_status === "pending") {
            setTimeout(() => this.pollStatus(), 2000);
        } else {
            this.mpState.status = "error";
            this.mpState.error = "Payment " + result.payment_status;
        }
    },

});
